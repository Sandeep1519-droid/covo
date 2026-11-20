import { describe, expect, test } from "bun:test";
import {
  describeSchedule,
  inQuietHours,
  nextRun,
  parseSchedule,
  parseTime,
  quietHoursEnd,
  routineFromChat,
  ScheduleError,
} from "./schedule.ts";

// Local times, so the tests mean the same in any time zone. 20 Nov 2026 is a Friday.
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();

describe("reading schedules", () => {
  test("the ways people say when", () => {
    expect(parseSchedule("weekdays 9:00")).toEqual({ kind: "times", days: [1, 2, 3, 4, 5], times: [540] });
    expect(parseSchedule("Every weekday at 07:30")).toEqual({ kind: "times", days: [1, 2, 3, 4, 5], times: [450] });
    expect(parseSchedule("every day at 7:30 and 18:00")).toEqual({
      kind: "times",
      days: [0, 1, 2, 3, 4, 5, 6],
      times: [450, 1080],
    });
    expect(parseSchedule("18:00")).toEqual({ kind: "times", days: [0, 1, 2, 3, 4, 5, 6], times: [1080] });
    expect(parseSchedule("mon, wed and fri at 8:30am")).toEqual({ kind: "times", days: [1, 3, 5], times: [510] });
    expect(parseSchedule("sundays 10am")).toEqual({ kind: "times", days: [0], times: [600] });
    expect(parseSchedule("every Monday at 9")).toEqual({ kind: "times", days: [1], times: [540] });
    expect(parseSchedule("weekends at noon")).toEqual({ kind: "times", days: [0, 6], times: [720] });
    expect(parseSchedule("hourly")).toEqual({ kind: "every", minutes: 60 });
    expect(parseSchedule("every 30 minutes")).toEqual({ kind: "every", minutes: 30 });
    expect(parseSchedule("every 2 hours")).toEqual({ kind: "every", minutes: 120 });
  });

  test("what it can't read, it says how to write it", () => {
    for (const bad of [
      "",
      "sometimes",
      "every blue moon at 9",
      "weekdays at 25:00",
      "every 2 minutes",
      "every 2 days",
    ]) {
      expect(() => parseSchedule(bad)).toThrow(ScheduleError);
    }
    expect(() => parseSchedule("sometimes")).toThrow('Try "weekdays 9:00"');
    expect(parseTime("6:30 pm")).toBe(18 * 60 + 30);
    expect(parseTime("12am")).toBe(0);
    expect(parseTime("13pm")).toBeNull();
  });

  test("in words, the way the app shows it", () => {
    expect(describeSchedule(parseSchedule("weekdays 8:30"))).toBe("Weekdays at 08:30");
    expect(describeSchedule(parseSchedule("every day at 7:30 and 18:00"))).toBe("Every day at 07:30 and 18:00");
    expect(describeSchedule(parseSchedule("fridays 16:00"))).toBe("Fridays at 16:00");
    expect(describeSchedule(parseSchedule("mon, wed, fri 9"))).toBe("Mon, Wed and Fri at 09:00");
    expect(describeSchedule(parseSchedule("every 30 minutes"))).toBe("Every 30 minutes");
    expect(describeSchedule(parseSchedule("hourly"))).toBe("Every hour");
  });
});

describe("when it runs next", () => {
  test("days and times", () => {
    const weekdays9 = parseSchedule("weekdays 9:00");
    expect(nextRun(weekdays9, at(20, 8, 0))).toBe(at(20, 9)); // Friday morning: today
    expect(nextRun(weekdays9, at(20, 9, 0))).toBe(at(23, 9)); // Friday 9:00 sharp: Monday
    const twice = parseSchedule("every day at 7:30 and 18:00");
    expect(nextRun(twice, at(20, 12))).toBe(at(20, 18));
    expect(nextRun(twice, at(20, 19))).toBe(at(21, 7, 30));
  });

  test("intervals run on the clock", () => {
    expect(nextRun(parseSchedule("every 30 minutes"), at(20, 10, 7))).toBe(at(20, 10, 30));
    expect(nextRun(parseSchedule("hourly"), at(20, 23, 15))).toBe(at(21, 0));
  });

  test("quiet hours, across midnight", () => {
    const q = { from: "22:00", to: "07:00" };
    expect(inQuietHours(at(20, 23), q)).toBe(true);
    expect(inQuietHours(at(20, 6, 59), q)).toBe(true);
    expect(inQuietHours(at(20, 7), q)).toBe(false);
    expect(inQuietHours(at(20, 23), null)).toBe(false);
    expect(quietHoursEnd(at(20, 23), q)).toBe(at(21, 7));
  });
});

describe("routines asked for in chat", () => {
  test("a schedule, a comma, then the task", () => {
    expect(routineFromChat("Every weekday at 07:30, brief me")).toMatchObject({
      every: "Every weekday at 07:30",
      task: "brief me",
    });
    expect(routineFromChat("every Monday at 9, summarise last week")?.schedule).toEqual({
      kind: "times",
      days: [1],
      times: [540],
    });
    expect(routineFromChat("every 30 minutes, check the build")?.schedule).toEqual({ kind: "every", minutes: 30 });
  });

  test("anything else stays a task", () => {
    expect(routineFromChat("every file here, rename it to lowercase")).toBeNull();
    expect(routineFromChat("tidy the README")).toBeNull();
    expect(routineFromChat("daily, do things")).toBeNull(); // no time
  });
});
