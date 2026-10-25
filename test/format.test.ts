import { describe, expect, test } from "bun:test";
import { formatBytes, humanizeTimes } from "../src/tools/format";

describe("humanizeTimes", () => {
  test("rewrites second and millisecond timestamps under time-like keys", () => {
    expect(
      humanizeTimes({
        files: [{ additional: { time: { mtime: 1669455464, crtime: 1669455358 } } }],
        StartedTs: 1789050423,
        timestamp: 1792944300827,
      }),
    ).toEqual({
      files: [{ additional: { time: { mtime: "2022-11-26T09:37:44Z", crtime: "2022-11-26T09:35:58Z" } } }],
      StartedTs: "2026-09-10T14:27:03Z",
      timestamp: "2026-10-25T16:05:00.827Z",
    });
  });

  test("leaves durations, other keys and strings alone", () => {
    const value = { erase_time: 484, next_schedule_time: 0, size: 1669455464, up_time: "1081:43:37" };
    expect(humanizeTimes(value)).toEqual(value);
  });
});

test("formatBytes", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes("3796407492608")).toBe("3.45 TiB");
});
