/* The content mapper processes of tsc-ts on Linux and macOS (spawn-posix.c). */
#ifndef TSC_TS_SPAWN_POSIX_H
#define TSC_TS_SPAWN_POSIX_H

#include <stddef.h>
#include <stdint.h>

/* Starts a process in the directory `directory` and returns its number, or
 * -1 when it cannot be started, which tsc_ts_spawn_error explains. `command`
 * holds the file to run and then the arguments of the process, the first of
 * which is its name, each followed by a NUL. The process reads its standard
 * input from, and writes its standard output to, pipes of this process. Its
 * standard error is discarded, or kept for tsc_ts_process_read_error when
 * `capture_error` is not 0. */
int32_t tsc_ts_spawn(const uint8_t *command, size_t command_size, const uint8_t *directory, size_t directory_size,
                     uint8_t capture_error);

/* Copies why the last tsc_ts_spawn failed, in the words of the system, into
 * `buffer` and returns the number of bytes copied. */
int32_t tsc_ts_spawn_error(uint8_t *buffer, size_t size);

/* Writes all of `bytes` to the standard input of a process; 0, or -1 when
 * they cannot be written: the process closed its input or ended. */
int32_t tsc_ts_process_write(int32_t process, const uint8_t *bytes, size_t size);

/* Waits for standard output of a process and reads it into `buffer`: the
 * number of bytes read, 0 when the process closed its output, -1 when
 * nothing arrived within `timeout_ms` milliseconds (never, when it is
 * negative), or -2 after an error. */
int32_t tsc_ts_process_read(int32_t process, uint8_t *buffer, size_t size, int32_t timeout_ms);

/* Copies standard error of a process that was started with `capture_error`
 * into `buffer`, without waiting for more, and returns the number of bytes
 * copied. What the process wrote before it was closed can still be read. */
int32_t tsc_ts_process_read_error(int32_t process, uint8_t *buffer, size_t size);

/* The exit code of a process that has ended, -1 for one a signal ended, or
 * -2 for one that still runs after `wait_ms` milliseconds. */
int32_t tsc_ts_process_exit_code(int32_t process, int32_t wait_ms);

/* Closes the pipes of a process and ends it. */
void tsc_ts_process_close(int32_t process);

#endif
