/* The content mapper processes of tsc-ts on Linux and macOS: a content
 * mapper runs as a process that answers requests on its standard input and
 * output, and the compiler waits for each answer. This starts the process
 * with pipes for both, waits for its output up to a time limit, and tells
 * whether it has ended and with what exit code, none of which the runtime's
 * own child processes offer without the event loop. Linked into the Linux
 * and macOS builds (scripts/build-native.mjs).
 *
 * A process is started as Go's os/exec starts one for tsgo: in its working
 * directory, with the environment of this process, and with its standard
 * error discarded unless it is captured. The functions keep their processes
 * in one table without a lock: one thread, the one that loads a program's
 * files, calls them. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "spawn-posix.h"

extern char **environ;

struct process {
  pid_t pid;
  /* The write end of the standard input, and the read ends of the standard
   * output and of a captured standard error; -1 once closed. */
  int input;
  int output;
  int error;
  /* Whether a standard error is captured, which is then emptied while the
   * process is written to. */
  int captures;
  /* Whether the process was waited for, and the status it ended with. */
  int exited;
  int status;
  /* Captured standard error that has not been read yet. */
  uint8_t *captured;
  size_t captured_size;
};

/* The processes started so far, by number. */
static struct process *processes;
static int32_t process_count;

/* Why the last tsc_ts_spawn failed. */
static int spawn_errno;

static int64_t now_ms(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static void close_on_exec(int fd) {
  int flags = fcntl(fd, F_GETFD);
  if (flags >= 0) fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
}

static void close_pipe(int ends[2]) {
  if (ends[0] >= 0) close(ends[0]);
  if (ends[1] >= 0) close(ends[1]);
}

/* Moves what a process has written to a captured standard error into its
 * buffer, without waiting. */
static void capture_error(struct process *p) {
  uint8_t chunk[4096];
  while (p->error >= 0) {
    ssize_t count = read(p->error, chunk, sizeof chunk);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
    if (count <= 0) {
      close(p->error);
      p->error = -1;
      return;
    }
    uint8_t *grown = realloc(p->captured, p->captured_size + (size_t)count);
    if (grown == NULL) return;
    memcpy(grown + p->captured_size, chunk, (size_t)count);
    p->captured = grown;
    p->captured_size += (size_t)count;
  }
}

int32_t tsc_ts_spawn(const uint8_t *command, size_t command_size, const uint8_t *directory, size_t directory_size,
                     uint8_t capture) {
  /* The words of `command`, each ending in a NUL: the file, then the
   * arguments. */
  size_t words = 0;
  for (size_t i = 0; i < command_size; i++)
    if (command[i] == 0) words++;
  char *text = malloc(command_size + 1);
  char **argv = malloc((words + 1) * sizeof *argv);
  char *working_directory = malloc(directory_size + 1);
  struct process *grown = realloc(processes, ((size_t)process_count + 1) * sizeof *processes);
  if (grown != NULL) processes = grown;
  int input[2] = {-1, -1}, output[2] = {-1, -1}, error[2] = {-1, -1}, failure[2] = {-1, -1};
  if (text == NULL || argv == NULL || working_directory == NULL || grown == NULL || words < 2) {
    spawn_errno = words < 2 ? EINVAL : ENOMEM;
    goto failed;
  }
  memcpy(text, command, command_size);
  text[command_size] = 0;
  memcpy(working_directory, directory, directory_size);
  working_directory[directory_size] = 0;
  size_t argc = 0;
  char *word = text;
  for (size_t i = 0; i < command_size; i++)
    if (text[i] == 0) {
      argv[argc++] = word;
      word = text + i + 1;
    }
  argv[argc] = NULL;
  /* The process reports a failure to start through `failure`, which a
   * successful exec closes, as every descriptor here. */
  if (pipe(input) != 0 || pipe(output) != 0 || (capture && pipe(error) != 0) || pipe(failure) != 0) {
    spawn_errno = errno;
    goto failed;
  }
  /* Only the ends that become its standard streams stay open in the process.
   * With the write end of its own input open it would never see the input
   * end. */
  int *pipes[4] = {input, output, error, failure};
  for (int i = 0; i < 4; i++)
    for (int end = 0; end < 2; end++)
      if (pipes[i][end] >= 0) close_on_exec(pipes[i][end]);
  /* A process that ended makes a write to its input fail with EPIPE instead
   * of ending this process. */
  signal(SIGPIPE, SIG_IGN);
  pid_t pid = fork();
  if (pid < 0) {
    spawn_errno = errno;
    goto failed;
  }
  if (pid == 0) {
    /* Only async-signal-safe calls from here: other threads of this process
     * may hold locks. */
    struct sigaction action;
    memset(&action, 0, sizeof action);
    action.sa_handler = SIG_DFL;
    sigaction(SIGPIPE, &action, NULL);
    int discarded = capture ? error[1] : open("/dev/null", O_WRONLY | O_CLOEXEC);
    if (discarded >= 0 && dup2(input[0], 0) >= 0 && dup2(output[1], 1) >= 0 && dup2(discarded, 2) >= 0 &&
        chdir(working_directory) == 0) {
      /* A pipe end that already had the number of its standard stream was
       * not duplicated, and would close. */
      for (int fd = 0; fd < 3; fd++) fcntl(fd, F_SETFD, 0);
      execve(argv[0], argv + 1, environ);
    }
    int code = errno;
    ssize_t written = write(failure[1], &code, sizeof code);
    (void)written;
    _exit(127);
  }
  close(input[0]);
  close(output[1]);
  if (capture) close(error[1]);
  close(failure[1]);
  input[0] = output[1] = error[1] = failure[1] = -1;
  int code = 0;
  ssize_t reported;
  do reported = read(failure[0], &code, sizeof code);
  while (reported < 0 && errno == EINTR);
  if (reported > 0) {
    while (waitpid(pid, NULL, 0) < 0 && errno == EINTR) {
    }
    spawn_errno = code;
    goto failed;
  }
  close(failure[0]);
  if (capture) {
    /* Neither pipe makes this process wait: the standard error is read as
     * far as it goes, and the input is written when it has room. */
    int flags = fcntl(error[0], F_GETFL);
    if (flags >= 0) fcntl(error[0], F_SETFL, flags | O_NONBLOCK);
    flags = fcntl(input[1], F_GETFL);
    if (flags >= 0) fcntl(input[1], F_SETFL, flags | O_NONBLOCK);
  }
  free(text);
  free(argv);
  free(working_directory);
  processes[process_count] = (struct process){pid, input[1], output[0], error[0], capture, 0, 0, NULL, 0};
  return process_count++;

failed:
  close_pipe(input);
  close_pipe(output);
  close_pipe(error);
  close_pipe(failure);
  free(text);
  free(argv);
  free(working_directory);
  return -1;
}

int32_t tsc_ts_spawn_error(uint8_t *buffer, size_t size) {
  const char *text = strerror(spawn_errno);
  size_t length = strlen(text);
  if (length > size) length = size;
  memcpy(buffer, text, length);
  return (int32_t)length;
}

int32_t tsc_ts_process_write(int32_t process, const uint8_t *bytes, size_t size) {
  struct process *p = &processes[process];
  size_t written = 0;
  while (written < size) {
    if (p->input < 0) return -1;
    if (p->captures) {
      /* A process that waits for room in the pipe of its standard error does
       * not read its input, so the pipe is emptied while the input is full. */
      struct pollfd fds[2] = {{p->input, POLLOUT, 0}, {p->error, POLLIN, 0}};
      if (poll(fds, p->error >= 0 ? 2 : 1, -1) < 0) {
        if (errno == EINTR) continue;
        return -1;
      }
      if (p->error >= 0 && fds[1].revents != 0) capture_error(p);
      if (fds[0].revents == 0) continue;
    }
    ssize_t count = write(p->input, bytes + written, size - written);
    if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
    if (count < 0) return -1;
    written += (size_t)count;
  }
  return 0;
}

int32_t tsc_ts_process_read(int32_t process, uint8_t *buffer, size_t size, int32_t timeout_ms) {
  struct process *p = &processes[process];
  if (p->output < 0) return -2;
  int64_t deadline = now_ms() + timeout_ms;
  for (;;) {
    /* A process that fills the pipe of its standard error would wait for
     * this process, so the pipe is emptied while its output is awaited. */
    struct pollfd fds[2] = {{p->output, POLLIN, 0}, {p->error, POLLIN, 0}};
    int64_t left = timeout_ms < 0 ? -1 : deadline - now_ms();
    if (timeout_ms >= 0 && left < 0) left = 0;
    int ready = poll(fds, p->error >= 0 ? 2 : 1, (int)left);
    if (ready == 0) return -1;
    if (ready < 0) {
      if (errno == EINTR) continue;
      return -2;
    }
    if (p->error >= 0 && fds[1].revents != 0) capture_error(p);
    if (fds[0].revents == 0) continue;
    ssize_t count = read(p->output, buffer, size);
    if (count < 0 && errno == EINTR) continue;
    return count < 0 ? -2 : (int32_t)count;
  }
}

int32_t tsc_ts_process_read_error(int32_t process, uint8_t *buffer, size_t size) {
  struct process *p = &processes[process];
  capture_error(p);
  size_t count = p->captured_size < size ? p->captured_size : size;
  if (count == 0) return 0;
  memcpy(buffer, p->captured, count);
  p->captured_size -= count;
  if (p->captured_size > 0) memmove(p->captured, p->captured + count, p->captured_size);
  else {
    free(p->captured);
    p->captured = NULL;
  }
  return (int32_t)count;
}

int32_t tsc_ts_process_exit_code(int32_t process, int32_t wait_ms) {
  struct process *p = &processes[process];
  int64_t deadline = now_ms() + wait_ms;
  while (!p->exited) {
    pid_t ended = waitpid(p->pid, &p->status, WNOHANG);
    if (ended == p->pid) {
      p->exited = 1;
      break;
    }
    if ((ended < 0 && errno != EINTR) || now_ms() >= deadline) return -2;
    struct timespec pause = {0, 1000000};
    nanosleep(&pause, NULL);
  }
  return WIFEXITED(p->status) ? WEXITSTATUS(p->status) : -1;
}

void tsc_ts_process_close(int32_t process) {
  struct process *p = &processes[process];
  if (p->input >= 0) close(p->input);
  p->input = -1;
  if (!p->exited) {
    kill(p->pid, SIGKILL);
    while (waitpid(p->pid, &p->status, 0) < 0 && errno == EINTR) {
    }
    p->exited = 1;
  }
  if (p->output >= 0) close(p->output);
  p->output = -1;
  /* What the process wrote to a captured standard error stays readable. */
  capture_error(p);
  if (p->error >= 0) close(p->error);
  p->error = -1;
}
