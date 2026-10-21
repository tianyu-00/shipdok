import { createRefusals } from "../src/webhookrefusals.js";

const clock = (start = 1_000_000) => { const c = { t: start, now: () => c.t }; return c; };

describe("the memory of refused pushes", () => {
  test("starts empty", () => {
    expect(createRefusals().list()).toEqual([]);
  });

  test("a refusal is kept with who, when and how many times", () => {
    const c = clock();
    const r = createRefusals({ now: c.now });
    r.record("111");
    c.t += 5000;
    r.record("111");
    r.record("111");
    expect(r.list()).toEqual([{ appNumber: "111", at: c.t, count: 3 }]);
  });

  test("a sender that did not say who it was is kept too, once", () => {
    const r = createRefusals();
    r.record(null);
    r.record(null);
    expect(r.list()).toMatchObject([{ appNumber: null, count: 2 }]);
  });

  test("each sender has its own entry, newest first", () => {
    const c = clock();
    const r = createRefusals({ now: c.now });
    r.record("111");
    c.t += 1000;
    r.record("222");
    c.t += 1000;
    r.record(null);
    expect(r.list().map((e) => e.appNumber)).toEqual([null, "222", "111"]);
  });

  test("clearing one sender leaves the others", () => {
    const r = createRefusals();
    r.record("111");
    r.record("222");
    r.clear("111");
    expect(r.list().map((e) => e.appNumber)).toEqual(["222"]);
    r.clear(null); // nothing there: no harm
    expect(r.list()).toHaveLength(1);
  });

  test("clearing the unnamed sender works", () => {
    const r = createRefusals();
    r.record(null);
    r.clear(null);
    expect(r.list()).toEqual([]);
  });

  test("an entry is forgotten after a day, but a newer refusal keeps it alive", () => {
    const c = clock();
    const r = createRefusals({ now: c.now });
    r.record("111");
    r.record("222");
    c.t += 23 * 3600_000;
    r.record("222");
    c.t += 2 * 3600_000; // 25 hours after the first
    expect(r.list().map((e) => e.appNumber)).toEqual(["222"]);
    c.t += 23 * 3600_000;
    expect(r.list()).toEqual([]);
  });

  test("after the same time passes the count starts again (it is forgotten, not kept)", () => {
    const c = clock();
    const r = createRefusals({ now: c.now });
    r.record("111");
    r.record("111");
    c.t += 25 * 3600_000;
    r.list(); // expired
    r.record("111");
    expect(r.list()[0].count).toBe(1);
  });

  test("the memory is bounded: many different senders cannot fill it", () => {
    const r = createRefusals({ max: 3 });
    for (const n of ["1", "2", "3"]) r.record(n);
    expect(r.list()).toHaveLength(3);
    r.record("4"); // a fourth different sender: it starts again
    expect(r.list().map((e) => e.appNumber)).toEqual(["4"]);
  });

  test("a sender already known does not use up room when the memory is full", () => {
    const r = createRefusals({ max: 3 });
    for (const n of ["1", "2", "3"]) r.record(n);
    r.record("2");
    expect(r.list()).toHaveLength(3);
    expect(r.list().find((e) => e.appNumber === "2").count).toBe(2);
  });
});
