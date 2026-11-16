'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../timer-core.js');

const { PHASE } = core;

// Small settings so the numbers are easy to read: 3 breaths at 2 s = 6 s of
// breathing, then a hold, then a 5 s recovery.
const SHORT = { rounds: 2, breaths: 3, paced: true, paceSeconds: 2, recoverySeconds: 5 };

function phasesOf(events) {
  return events.filter((e) => e.type === 'phase').map((e) => e.phase);
}

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    data
  };
}

function throwingStorage() {
  const fail = () => {
    throw new Error('storage blocked');
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

test('settings: defaults and limits', async (t) => {
  await t.test('empty input gives the defaults', () => {
    assert.deepEqual(core.normalizeSettings(), {
      rounds: 3,
      breaths: 30,
      paced: true,
      paceSeconds: 2,
      recoverySeconds: 15
    });
  });

  await t.test('values are clamped and rounded to their step', () => {
    const s = core.normalizeSettings({
      rounds: 0,
      breaths: 500,
      paceSeconds: 2.3,
      recoverySeconds: -4,
      paced: false
    });
    assert.equal(s.rounds, 1);
    assert.equal(s.breaths, 100);
    assert.equal(s.paceSeconds, 2.5);
    assert.equal(s.recoverySeconds, 0);
    assert.equal(s.paced, false);
  });

  await t.test('garbage falls back to defaults', () => {
    const s = core.normalizeSettings({ rounds: 'abc', breaths: null, paceSeconds: NaN, recoverySeconds: '' });
    assert.equal(s.rounds, 3);
    assert.equal(s.breaths, 30);
    assert.equal(s.paceSeconds, 2);
    assert.equal(s.recoverySeconds, 15);
  });
});

test('round sequencing', async (t) => {
  await t.test('runs breathe, hold, recover for each round, then done', () => {
    const timer = core.createTimer(SHORT);
    assert.equal(timer.view(0).phase, PHASE.IDLE);

    assert.deepEqual(phasesOf(timer.start(1000)), [PHASE.BREATHE]);
    let v = timer.view(1000);
    assert.equal(v.round, 1);
    assert.equal(v.breath, 1);

    // Breath count follows the pace: breath 2 starts at 2 s, breath 3 at 4 s.
    assert.equal(timer.view(2999).breath, 1);
    assert.equal(timer.view(3000).breath, 2);
    assert.equal(timer.view(5000).breath, 3);

    // 3 breaths x 2 s after the start at 1000 ms, the hold begins.
    assert.deepEqual(phasesOf(timer.tick(6999)), []);
    assert.deepEqual(phasesOf(timer.tick(7000)), [PHASE.HOLD]);

    const holdEnd = timer.endHold(7000 + 72000);
    assert.deepEqual(phasesOf(holdEnd), [PHASE.RECOVER]);
    assert.equal(holdEnd.find((e) => e.type === 'hold-recorded').ms, 72000);

    // Recovery is 5 s, then round 2 starts.
    assert.deepEqual(phasesOf(timer.tick(79000 + 4999)), []);
    const next = timer.tick(79000 + 5000);
    assert.deepEqual(phasesOf(next), [PHASE.BREATHE]);
    assert.equal(next[0].round, 2);
    assert.equal(timer.view(84000).round, 2);

    timer.tick(84000 + 6000); // hold of round 2 begins
    assert.equal(timer.view(90000).phase, PHASE.HOLD);
    timer.endHold(90000 + 91000);
    const end = timer.tick(181000 + 5000);
    assert.deepEqual(phasesOf(end), [PHASE.DONE]);

    v = timer.view(200000);
    assert.equal(v.phase, PHASE.DONE);
    assert.equal(v.stopped, false);
    assert.deepEqual(v.holds, [
      { round: 1, ms: 72000 },
      { round: 2, ms: 91000 }
    ]);
  });

  await t.test('start only works once', () => {
    const timer = core.createTimer(SHORT);
    timer.start(0);
    assert.deepEqual(timer.start(10), []);
    assert.equal(timer.view(10).round, 1);
  });

  await t.test('a late tick crosses several boundaries and keeps exact start times', () => {
    const timer = core.createTimer(SHORT);
    timer.start(0);
    timer.tick(6000);
    timer.endHold(10000); // recovery 10000 to 15000, round 2 breathing 15000 to 21000
    const events = timer.tick(30000);
    assert.deepEqual(phasesOf(events), [PHASE.BREATHE, PHASE.HOLD]);
    assert.equal(events[0].at, 15000);
    assert.equal(events[1].at, 21000);
    // The hold has been running since 21000, not since the late tick.
    assert.equal(timer.view(30000).holdMs, 9000);
  });

  await t.test('zero recovery goes straight to the next round', () => {
    const timer = core.createTimer({ ...SHORT, recoverySeconds: 0 });
    timer.start(0);
    timer.tick(6000);
    const events = timer.endHold(9000);
    assert.deepEqual(phasesOf(events), [PHASE.BREATHE]);
    assert.equal(timer.view(9000).round, 2);
  });

  await t.test('start hold now skips the rest of the breathing', () => {
    const timer = core.createTimer(SHORT);
    timer.start(0);
    assert.deepEqual(phasesOf(timer.startHold(2500)), [PHASE.HOLD]);
    assert.equal(timer.view(4500).holdMs, 2000);
  });

  await t.test('self-paced mode counts taps and starts the hold on the last one', () => {
    const timer = core.createTimer({ ...SHORT, paced: false });
    timer.start(0);
    // Without a pace, time alone never ends the breathing phase.
    assert.deepEqual(phasesOf(timer.tick(600000)), []);
    assert.equal(timer.view(600000).breath, 0);
    timer.countBreath(600100);
    timer.countBreath(600200);
    assert.equal(timer.view(600200).breath, 2);
    assert.deepEqual(phasesOf(timer.countBreath(600300)), [PHASE.HOLD]);
    assert.equal(timer.view(601300).holdMs, 1000);
  });

  await t.test('counting taps is ignored in paced mode', () => {
    const timer = core.createTimer(SHORT);
    timer.start(0);
    timer.countBreath(100);
    timer.countBreath(200);
    timer.countBreath(300);
    assert.equal(timer.view(300).phase, PHASE.BREATHE);
  });

  await t.test('stop ends early, keeps finished holds and drops a hold in progress', () => {
    const timer = core.createTimer(SHORT);
    timer.start(0);
    timer.tick(6000);
    timer.endHold(36000);
    timer.tick(41000); // round 2 breathing
    timer.tick(47000); // round 2 hold
    assert.deepEqual(phasesOf(timer.stop(50000)), [PHASE.DONE]);
    const v = timer.view(50000);
    assert.equal(v.stopped, true);
    assert.deepEqual(v.holds, [{ round: 1, ms: 30000 }]);
    assert.deepEqual(timer.stop(51000), []);
  });
});

test('hold stopwatch', async (t) => {
  await t.test('counts up from zero until it is ended', () => {
    const timer = core.createTimer(SHORT);
    timer.start(0);
    timer.tick(6000);
    assert.equal(timer.view(6000).holdMs, 0);
    assert.equal(timer.view(6500).holdMs, 500);
    assert.equal(timer.view(6000 + 754000).holdMs, 754000);
    assert.equal(core.formatDuration(timer.view(6000 + 754000).holdMs), '12:34');
  });

  await t.test('cannot be paused', () => {
    const timer = core.createTimer(SHORT);
    timer.start(0);
    timer.tick(6000);
    assert.deepEqual(timer.pause(7000), []);
    assert.equal(timer.view(9000).paused, false);
    assert.equal(timer.view(9000).holdMs, 3000);
  });

  await t.test('endHold does nothing outside a hold', () => {
    const timer = core.createTimer(SHORT);
    assert.deepEqual(timer.endHold(0), []);
    timer.start(0);
    assert.deepEqual(timer.endHold(1000), []);
    assert.equal(timer.view(1000).holds.length, 0);
  });

  await t.test('a hold that ended in a late tick still starts at the boundary', () => {
    const timer = core.createTimer(SHORT);
    timer.start(0);
    // No tick at 6000. The press at 8000 should record 2000 ms, not 0.
    const events = timer.endHold(8000);
    assert.equal(events.find((e) => e.type === 'hold-recorded').ms, 2000);
  });

  await t.test('formatDuration', () => {
    assert.equal(core.formatDuration(0), '0:00');
    assert.equal(core.formatDuration(999), '0:00');
    assert.equal(core.formatDuration(2000), '0:02');
    assert.equal(core.formatDuration(72000), '1:12');
    assert.equal(core.formatDuration(91500), '1:31');
    assert.equal(core.formatDuration(3600000 + 3000), '60:03');
    assert.equal(core.formatDuration(-50), '0:00');
  });
});

test('recovery countdown', async (t) => {
  await t.test('counts down from the recovery length', () => {
    const timer = core.createTimer({ ...SHORT, recoverySeconds: 15 });
    timer.start(0);
    timer.tick(6000);
    timer.endHold(10000);
    let v = timer.view(10000);
    assert.equal(v.phase, PHASE.RECOVER);
    assert.equal(v.recoverRemainingMs, 15000);
    assert.equal(core.countdownSeconds(v.recoverRemainingMs), 15);
    v = timer.view(10001);
    assert.equal(core.countdownSeconds(v.recoverRemainingMs), 15);
    v = timer.view(11000);
    assert.equal(core.countdownSeconds(v.recoverRemainingMs), 14);
    v = timer.view(24500);
    assert.equal(core.countdownSeconds(v.recoverRemainingMs), 1);
    assert.deepEqual(phasesOf(timer.tick(25000)), [PHASE.BREATHE]);
  });

  await t.test('the last round recovery ends the session', () => {
    const timer = core.createTimer({ ...SHORT, rounds: 1 });
    timer.start(0);
    timer.tick(6000);
    timer.endHold(8000);
    assert.deepEqual(phasesOf(timer.tick(13000)), [PHASE.DONE]);
  });

  await t.test('countdownSeconds never goes negative', () => {
    assert.equal(core.countdownSeconds(-1), 0);
    assert.equal(core.countdownSeconds(0), 0);
  });
});

test('pause and resume', async (t) => {
  await t.test('pausing the breathing freezes the count and the phase end', () => {
    const timer = core.createTimer(SHORT);
    timer.start(0);
    assert.deepEqual(timer.pause(3000).map((e) => e.type), ['pause']);
    let v = timer.view(60000);
    assert.equal(v.paused, true);
    assert.equal(v.breath, 2);
    assert.equal(v.elapsedMs, 3000);
    // While paused, time does not move the phase on.
    assert.deepEqual(timer.tick(60000), []);
    assert.equal(timer.view(60000).phase, PHASE.BREATHE);

    timer.resume(10000); // paused for 7000 ms
    v = timer.view(10000);
    assert.equal(v.paused, false);
    assert.equal(v.elapsedMs, 3000);
    // 6000 ms of breathing plus 7000 ms paused: the hold starts at 13000.
    assert.deepEqual(phasesOf(timer.tick(12999)), []);
    const events = timer.tick(13000);
    assert.deepEqual(phasesOf(events), [PHASE.HOLD]);
    assert.equal(events[0].at, 13000);
  });

  await t.test('pausing the recovery freezes the countdown', () => {
    const timer = core.createTimer(SHORT);
    timer.start(0);
    timer.tick(6000);
    timer.endHold(10000); // recovery 5 s
    timer.pause(12000);
    assert.equal(timer.view(40000).recoverRemainingMs, 3000);
    timer.resume(40000);
    assert.equal(timer.view(41000).recoverRemainingMs, 2000);
    assert.deepEqual(phasesOf(timer.tick(43000)), [PHASE.BREATHE]);
  });

  await t.test('togglePause switches back and forth', () => {
    const timer = core.createTimer(SHORT);
    timer.start(0);
    timer.togglePause(1000);
    assert.equal(timer.view(1500).paused, true);
    timer.togglePause(2000);
    assert.equal(timer.view(2000).paused, false);
    assert.equal(timer.view(2000).elapsedMs, 1000);
  });

  await t.test('several pauses add up', () => {
    const timer = core.createTimer(SHORT);
    timer.start(0);
    timer.pause(1000);
    timer.resume(2000);
    timer.pause(3000);
    timer.resume(5000);
    assert.equal(timer.view(5000).elapsedMs, 2000);
    assert.deepEqual(phasesOf(timer.tick(8999)), []);
    assert.deepEqual(phasesOf(timer.tick(9000)), [PHASE.HOLD]);
  });

  await t.test('pause and resume are ignored when they do not apply', () => {
    const timer = core.createTimer(SHORT);
    assert.deepEqual(timer.pause(0), []);
    assert.deepEqual(timer.resume(0), []);
    timer.start(0);
    timer.pause(1000);
    assert.deepEqual(timer.pause(1500), []);
    assert.deepEqual(timer.startHold(1600), []);
  });

  await t.test('stopping while paused finishes cleanly', () => {
    const timer = core.createTimer(SHORT);
    timer.start(0);
    timer.pause(1000);
    timer.stop(5000);
    const v = timer.view(9000);
    assert.equal(v.phase, PHASE.DONE);
    assert.equal(v.paused, false);
  });
});

test('results and history', async (t) => {
  await t.test('summarizeHolds finds the longest and the average', () => {
    const s = core.summarizeHolds([{ ms: 72000 }, { ms: 91000 }, { ms: 80000 }]);
    assert.equal(s.count, 3);
    assert.equal(s.longestMs, 91000);
    assert.equal(s.averageMs, 81000);
    assert.deepEqual(core.summarizeHolds([]), { count: 0, totalMs: 0, longestMs: 0, averageMs: 0 });
  });

  await t.test('makeHistoryEntry stores whole milliseconds per round', () => {
    const timer = core.createTimer({ ...SHORT, rounds: 1 });
    timer.start(0);
    timer.tick(6000);
    timer.endHold(8000.4);
    const entry = core.makeHistoryEntry(timer.view(8001), '2026-11-16T10:00:00.000Z');
    assert.deepEqual(entry, { date: '2026-11-16T10:00:00.000Z', holds: [2000], breaths: 3, rounds: 1 });
  });

  await t.test('addToHistory puts the newest first, caps the list, skips empty sessions', () => {
    const a = { date: '2026-11-01T00:00:00.000Z', holds: [60000] };
    const b = { date: '2026-11-02T00:00:00.000Z', holds: [70000, 80000] };
    let list = core.addToHistory([], a);
    list = core.addToHistory(list, b);
    assert.deepEqual(list, [b, a]);
    assert.deepEqual(core.addToHistory(list, { date: 'x', holds: [] }), [b, a]);
    let many = [];
    for (let i = 0; i < 60; i += 1) {
      many = core.addToHistory(many, { date: 'd' + i, holds: [i * 1000] });
    }
    assert.equal(many.length, core.HISTORY_LIMIT);
    assert.equal(many[0].date, 'd59');
    assert.equal(core.addToHistory([a, b], { date: 'c', holds: [1] }, 2).length, 2);
  });

  await t.test('parseHistory rejects corrupt or wrongly shaped data', () => {
    assert.deepEqual(core.parseHistory(null), []);
    assert.deepEqual(core.parseHistory('not json{'), []);
    assert.deepEqual(core.parseHistory('{"a":1}'), []);
    const mixed = JSON.stringify([
      { date: '2026-11-01', holds: [1000] },
      { date: '2026-11-02', holds: ['bad'] },
      { holds: [1000] },
      null,
      { date: '2026-11-03', holds: [-5] }
    ]);
    assert.deepEqual(core.parseHistory(mixed), [{ date: '2026-11-01', holds: [1000] }]);
  });

  await t.test('history store saves, loads and clears', () => {
    const storage = memoryStorage();
    const store = core.createHistoryStore(storage);
    assert.deepEqual(store.load(), []);
    const result = store.add({ date: '2026-11-16T10:00:00.000Z', holds: [72000, 91000] });
    assert.equal(result.saved, true);
    assert.equal(store.load().length, 1);
    assert.deepEqual(store.load()[0].holds, [72000, 91000]);
    assert.equal(store.clear(), true);
    assert.deepEqual(store.load(), []);
  });

  await t.test('history store survives storage that throws or is missing', () => {
    const blocked = core.createHistoryStore(throwingStorage());
    assert.deepEqual(blocked.load(), []);
    const r = blocked.add({ date: '2026-11-16', holds: [1000] });
    assert.equal(r.saved, false);
    assert.equal(r.list.length, 1);
    assert.equal(blocked.clear(), false);

    const none = core.createHistoryStore(null);
    assert.deepEqual(none.load(), []);
    assert.equal(none.add({ date: 'x', holds: [1] }).saved, false);
    assert.equal(none.clear(), false);
  });

  await t.test('history store ignores a corrupt saved value', () => {
    const storage = memoryStorage();
    storage.setItem(core.HISTORY_KEY, '[[[');
    const store = core.createHistoryStore(storage);
    assert.deepEqual(store.load(), []);
    store.add({ date: 'x', holds: [5] });
    assert.equal(store.load().length, 1);
  });

  await t.test('prefs store remembers settings and sound, with safe fallbacks', () => {
    const storage = memoryStorage();
    const prefs = core.createPrefsStore(storage);
    assert.equal(prefs.load().sound, false);
    assert.equal(prefs.load().rounds, 3);
    prefs.save({ rounds: 5, breaths: 40, paced: false, paceSeconds: 3, recoverySeconds: 20, sound: true });
    const loaded = prefs.load();
    assert.equal(loaded.rounds, 5);
    assert.equal(loaded.paced, false);
    assert.equal(loaded.sound, true);

    storage.setItem(core.PREFS_KEY, '{oops');
    assert.equal(prefs.load().rounds, 3);
    const blocked = core.createPrefsStore(throwingStorage());
    assert.equal(blocked.load().breaths, 30);
    assert.equal(blocked.save({ rounds: 2 }), false);
  });
});

test('space key on the page', async (t) => {
  const act = core.spaceKeyAction;
  const GUARD = core.FINISH_GUARD_MS;

  await t.test('the guard after a session ends is 800 ms', () => {
    assert.equal(GUARD, 800);
  });

  await t.test('setup: Space on the page starts a session, focused controls handle it themselves', () => {
    assert.equal(act('setup', 'page', Infinity), 'start');
    assert.equal(act('setup', 'control', Infinity), 'native');
    assert.equal(act('setup', 'typing', Infinity), 'native');
  });

  await t.test('running: Space on the page runs the main button', () => {
    assert.equal(act('run', 'page', Infinity), 'primary');
    assert.equal(act('run', 'control', Infinity), 'native');
    assert.equal(act('run', 'typing', Infinity), 'native');
  });

  await t.test('results: a quick second press after the hold ends is ignored, wherever focus is', () => {
    for (const focus of ['page', 'again', 'control']) {
      assert.equal(act('results', focus, 0), 'ignore', focus + ' at 0 ms');
      assert.equal(act('results', focus, 150), 'ignore', focus + ' at 150 ms');
      assert.equal(act('results', focus, GUARD - 1), 'ignore', focus + ' just inside the guard');
    }
  });

  await t.test('results: after the guard only a focused Start again (or another focused control) acts', () => {
    assert.equal(act('results', 'again', GUARD), 'native');
    assert.equal(act('results', 'again', 60000), 'native');
    assert.equal(act('results', 'control', GUARD), 'native');
    // Focus on the results heading or the page never starts a new session.
    assert.equal(act('results', 'page', GUARD), 'ignore');
    assert.equal(act('results', 'page', 60000), 'ignore');
  });

  await t.test('results: a missing finish time counts as inside the guard', () => {
    assert.equal(act('results', 'again', NaN), 'ignore');
    assert.equal(act('results', 'again', undefined), 'ignore');
  });
});
