/*
 * Breathwork Round and Hold Timer: core logic.
 *
 * Plain script with no dependencies. In the browser it defines
 * window.BreathTimerCore; in Node it is a CommonJS module, so the page and
 * the tests run the same code.
 *
 * Every function that depends on time takes `now` (milliseconds from any
 * steady clock, such as performance.now()) as an argument. Nothing in here
 * reads a clock or starts a timer, which keeps it easy to test. Phase times
 * come from timestamps, and a phase starts at its scheduled boundary rather
 * than at the moment a late tick noticed it, so a slow or backgrounded tab
 * does not stretch or shrink a hold.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    root.BreathTimerCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PHASE = Object.freeze({
    IDLE: 'idle',
    BREATHE: 'breathe',
    HOLD: 'hold',
    RECOVER: 'recover',
    DONE: 'done'
  });

  var LIMITS = Object.freeze({
    rounds: { min: 1, max: 20, step: 1, def: 3 },
    breaths: { min: 1, max: 100, step: 1, def: 30 },
    paceSeconds: { min: 1, max: 10, step: 0.5, def: 2 },
    recoverySeconds: { min: 0, max: 120, step: 1, def: 15 }
  });

  var DEFAULTS = Object.freeze({
    rounds: LIMITS.rounds.def,
    breaths: LIMITS.breaths.def,
    paced: true,
    paceSeconds: LIMITS.paceSeconds.def,
    recoverySeconds: LIMITS.recoverySeconds.def
  });

  function clampNumber(value, limit) {
    if (value === null || value === undefined || value === '') return limit.def;
    var n = Number(value);
    if (!isFinite(n)) return limit.def;
    n = Math.round(n / limit.step) * limit.step;
    return Math.min(limit.max, Math.max(limit.min, n));
  }

  function normalizeSettings(input) {
    var src = input && typeof input === 'object' ? input : {};
    return {
      rounds: clampNumber(src.rounds, LIMITS.rounds),
      breaths: clampNumber(src.breaths, LIMITS.breaths),
      paced: src.paced === undefined ? DEFAULTS.paced : Boolean(src.paced),
      paceSeconds: clampNumber(src.paceSeconds, LIMITS.paceSeconds),
      recoverySeconds: clampNumber(src.recoverySeconds, LIMITS.recoverySeconds)
    };
  }

  /*
   * createTimer(settings) returns a small state machine:
   *   idle -> breathe -> hold -> recover -> breathe (next round) ... -> done
   * Methods return an array of events, for example
   *   { type: 'phase', phase: 'hold', round: 1, at: 6000 }
   * so the page can play a cue or announce the change.
   */
  function createTimer(settingsInput) {
    var settings = normalizeSettings(settingsInput);
    var state = {
      phase: PHASE.IDLE,
      round: 0,
      phaseStart: 0,
      pausedAt: null,
      pausedMs: 0,
      tapped: 0,
      holds: [],
      startedAt: null,
      endedAt: null,
      stopped: false
    };

    function breatheMs() {
      return settings.breaths * settings.paceSeconds * 1000;
    }

    function recoverMs() {
      return settings.recoverySeconds * 1000;
    }

    function paceMs() {
      return settings.paceSeconds * 1000;
    }

    function isPaused() {
      return state.pausedAt !== null;
    }

    function isRunning() {
      return state.phase === PHASE.BREATHE || state.phase === PHASE.HOLD || state.phase === PHASE.RECOVER;
    }

    // Active (unpaused) time spent in the current phase.
    function phaseElapsed(now) {
      var end = isPaused() ? state.pausedAt : now;
      return Math.max(0, end - state.phaseStart - state.pausedMs);
    }

    function enter(phase, at, events) {
      state.phase = phase;
      state.phaseStart = at;
      state.pausedAt = null;
      state.pausedMs = 0;
      state.tapped = 0;
      events.push({ type: 'phase', phase: phase, round: state.round, at: at });
    }

    function finish(at, events) {
      state.endedAt = at;
      enter(PHASE.DONE, at, events);
    }

    function nextRoundOrFinish(at, events) {
      if (state.round >= settings.rounds) {
        finish(at, events);
      } else {
        state.round += 1;
        enter(PHASE.BREATHE, at, events);
      }
    }

    function startRecovery(at, events) {
      if (recoverMs() > 0) {
        enter(PHASE.RECOVER, at, events);
      } else {
        nextRoundOrFinish(at, events);
      }
    }

    // Moves through every phase boundary that has passed by `now`.
    function advance(now, events) {
      for (var guard = 0; guard < 10000; guard += 1) {
        if (isPaused()) return;
        var boundary;
        if (state.phase === PHASE.BREATHE && settings.paced) {
          boundary = state.phaseStart + state.pausedMs + breatheMs();
          if (now >= boundary) {
            enter(PHASE.HOLD, boundary, events);
            continue;
          }
        } else if (state.phase === PHASE.RECOVER) {
          boundary = state.phaseStart + state.pausedMs + recoverMs();
          if (now >= boundary) {
            nextRoundOrFinish(boundary, events);
            continue;
          }
        }
        return;
      }
    }

    function start(now) {
      var events = [];
      if (state.phase !== PHASE.IDLE) return events;
      state.startedAt = now;
      state.round = 1;
      enter(PHASE.BREATHE, now, events);
      advance(now, events);
      return events;
    }

    function tick(now) {
      var events = [];
      advance(now, events);
      return events;
    }

    // Self-paced mode: the person taps once per breath.
    function countBreath(now) {
      var events = [];
      advance(now, events);
      if (state.phase !== PHASE.BREATHE || settings.paced || isPaused()) return events;
      state.tapped += 1;
      if (state.tapped >= settings.breaths) {
        enter(PHASE.HOLD, now, events);
      }
      return events;
    }

    // Skip the rest of the breathing phase and start the hold now.
    function startHold(now) {
      var events = [];
      advance(now, events);
      if (state.phase !== PHASE.BREATHE || isPaused()) return events;
      enter(PHASE.HOLD, now, events);
      return events;
    }

    function endHold(now) {
      var events = [];
      advance(now, events);
      if (state.phase !== PHASE.HOLD) return events;
      var ms = Math.max(0, now - state.phaseStart);
      state.holds.push({ round: state.round, ms: ms });
      events.push({ type: 'hold-recorded', round: state.round, ms: ms, at: now });
      startRecovery(now, events);
      return events;
    }

    // A hold cannot be paused: the stopwatch is the point of the hold.
    function pause(now) {
      var events = [];
      advance(now, events);
      if (isPaused()) return events;
      if (state.phase !== PHASE.BREATHE && state.phase !== PHASE.RECOVER) return events;
      state.pausedAt = now;
      events.push({ type: 'pause', phase: state.phase, round: state.round, at: now });
      return events;
    }

    function resume(now) {
      var events = [];
      if (!isPaused()) return events;
      state.pausedMs += Math.max(0, now - state.pausedAt);
      state.pausedAt = null;
      events.push({ type: 'resume', phase: state.phase, round: state.round, at: now });
      advance(now, events);
      return events;
    }

    function togglePause(now) {
      return isPaused() ? resume(now) : pause(now);
    }

    // End the session early. A hold in progress is not recorded.
    function stop(now) {
      var events = [];
      if (!isRunning()) return events;
      state.stopped = true;
      state.pausedAt = null;
      finish(now, events);
      return events;
    }

    function view(now) {
      var elapsed = phaseElapsed(now);
      var v = {
        phase: state.phase,
        round: state.round,
        rounds: settings.rounds,
        breaths: settings.breaths,
        paced: settings.paced,
        paused: isPaused(),
        stopped: state.stopped,
        elapsedMs: state.phase === PHASE.IDLE || state.phase === PHASE.DONE ? 0 : elapsed,
        breath: 0,
        breathFraction: 0,
        holdMs: 0,
        recoverRemainingMs: 0,
        holds: state.holds.map(function (h) {
          return { round: h.round, ms: h.ms };
        })
      };
      if (state.phase === PHASE.BREATHE) {
        if (settings.paced) {
          var p = paceMs();
          v.breath = Math.min(settings.breaths, Math.floor(elapsed / p) + 1);
          v.breathFraction = elapsed >= breatheMs() ? 1 : (elapsed % p) / p;
        } else {
          v.breath = state.tapped;
        }
      } else if (state.phase === PHASE.HOLD) {
        v.holdMs = elapsed;
      } else if (state.phase === PHASE.RECOVER) {
        v.recoverRemainingMs = Math.max(0, recoverMs() - elapsed);
      }
      return v;
    }

    return {
      settings: settings,
      start: start,
      tick: tick,
      countBreath: countBreath,
      startHold: startHold,
      endHold: endHold,
      pause: pause,
      resume: resume,
      togglePause: togglePause,
      stop: stop,
      view: view
    };
  }

  // 72000 -> "1:12". Hours roll into minutes ("75:03").
  function formatDuration(ms) {
    var total = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
  }

  // Whole seconds left, rounded up, so a 15 second countdown shows 15 first.
  function countdownSeconds(ms) {
    return Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  }

  function summarizeHolds(holds) {
    var list = Array.isArray(holds) ? holds : [];
    var total = 0;
    var longest = 0;
    for (var i = 0; i < list.length; i += 1) {
      var ms = typeof list[i] === 'number' ? list[i] : list[i] && list[i].ms;
      ms = Number(ms) || 0;
      total += ms;
      if (ms > longest) longest = ms;
    }
    return {
      count: list.length,
      totalMs: total,
      longestMs: longest,
      averageMs: list.length ? Math.round(total / list.length) : 0
    };
  }

  /* ---------- History (kept only in this browser) ---------- */

  var HISTORY_KEY = 'breath-round-timer:history:v1';
  var PREFS_KEY = 'breath-round-timer:prefs:v1';
  var HISTORY_LIMIT = 50;

  function isValidEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.date !== 'string' || !entry.date) return false;
    if (!Array.isArray(entry.holds) || entry.holds.length === 0) return false;
    for (var i = 0; i < entry.holds.length; i += 1) {
      var ms = entry.holds[i];
      if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return false;
    }
    return true;
  }

  function parseHistory(text) {
    if (typeof text !== 'string' || !text) return [];
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return [];
    }
    if (!Array.isArray(data)) return [];
    return data.filter(isValidEntry).slice(0, HISTORY_LIMIT);
  }

  function makeHistoryEntry(timerView, dateIso) {
    var holds = (timerView && timerView.holds ? timerView.holds : []).map(function (h) {
      return Math.max(0, Math.round(h.ms));
    });
    return {
      date: dateIso,
      holds: holds,
      breaths: timerView ? timerView.breaths : undefined,
      rounds: timerView ? timerView.rounds : undefined
    };
  }

  // Newest first, capped at `limit`. Entries without holds are skipped.
  function addToHistory(list, entry, limit) {
    var max = typeof limit === 'number' && limit > 0 ? limit : HISTORY_LIMIT;
    var current = Array.isArray(list) ? list.filter(isValidEntry) : [];
    if (!isValidEntry(entry)) return current.slice(0, max);
    return [entry].concat(current).slice(0, max);
  }

  /*
   * storage is anything shaped like window.localStorage, or null. Every call
   * is wrapped, because storage can be missing or throw in a private window,
   * with blocked site data, or when it is full.
   */
  function createHistoryStore(storage) {
    function load() {
      if (!storage) return [];
      try {
        return parseHistory(storage.getItem(HISTORY_KEY));
      } catch (e) {
        return [];
      }
    }
    function save(list) {
      if (!storage) return false;
      try {
        storage.setItem(HISTORY_KEY, JSON.stringify(list));
        return true;
      } catch (e) {
        return false;
      }
    }
    function add(entry) {
      var list = addToHistory(load(), entry);
      var saved = save(list);
      return { list: list, saved: saved };
    }
    function clear() {
      if (!storage) return false;
      try {
        storage.removeItem(HISTORY_KEY);
        return true;
      } catch (e) {
        return false;
      }
    }
    return { load: load, save: save, add: add, clear: clear };
  }

  // Remembers the last settings and the sound choice for this viewer.
  function createPrefsStore(storage) {
    function load() {
      var raw = null;
      if (storage) {
        try {
          raw = JSON.parse(storage.getItem(PREFS_KEY) || 'null');
        } catch (e) {
          raw = null;
        }
      }
      var prefs = normalizeSettings(raw || {});
      prefs.sound = Boolean(raw && raw.sound === true);
      return prefs;
    }
    function save(prefs) {
      if (!storage) return false;
      try {
        var clean = normalizeSettings(prefs);
        clean.sound = Boolean(prefs && prefs.sound === true);
        storage.setItem(PREFS_KEY, JSON.stringify(clean));
        return true;
      } catch (e) {
        return false;
      }
    }
    return { load: load, save: save };
  }

  return {
    PHASE: PHASE,
    LIMITS: LIMITS,
    DEFAULTS: DEFAULTS,
    HISTORY_KEY: HISTORY_KEY,
    PREFS_KEY: PREFS_KEY,
    HISTORY_LIMIT: HISTORY_LIMIT,
    normalizeSettings: normalizeSettings,
    clampNumber: clampNumber,
    createTimer: createTimer,
    formatDuration: formatDuration,
    countdownSeconds: countdownSeconds,
    summarizeHolds: summarizeHolds,
    parseHistory: parseHistory,
    makeHistoryEntry: makeHistoryEntry,
    addToHistory: addToHistory,
    createHistoryStore: createHistoryStore,
    createPrefsStore: createPrefsStore
  };
});
