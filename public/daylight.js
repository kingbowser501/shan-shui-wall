// Daylight schedule for the painting: follows the sun and holds still at night.
//
//   day      full brightness
//   dusk     eases down to the evening level around sunset
//   evening  dimmer, still drifting
//   hold     after midnight: the painting fades into a near-black night screen with a
//            dim clock, the backlight drops to almost nothing, the drift comes to rest
//   dawn     at 6:00 the drift resumes; brightness rises through sunrise
//
// Shared by painting.js (which applies it) and remote.html (which shows it).
// Sun times use the standard sunrise equation (as in SunCalc); accurate to a
// minute or two, which is plenty for easing a backlight.

"use strict";

const Daylight = (() => {
  const LEVELS = { day: 1, evening: 0.5, hold: 0.03 }; // backlight multipliers; hold is absolute
  const DUSK = [-30, 45]; // minutes around sunset over which day eases to evening
  const DAWN = [-45, 30]; // minutes around sunrise over which evening eases to day
  const HOLD = { start: 0, end: 6, ramp: 20 }; // hours (local), ramp in minutes

  const rad = Math.PI / 180;
  const DAY_MS = 864e5;
  const J1970 = 2440588;
  const J2000 = 2451545;

  // Sunrise and sunset for the local calendar day containing `date`.
  function sunTimes(date, lat, lon) {
    const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
    const d = noon.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
    const lw = -lon * rad;
    const phi = lat * rad;
    const n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
    const ds = 0.0009 + lw / (2 * Math.PI) + n;
    const M = rad * (357.5291 + 0.98560028 * ds);
    const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L = M + C + rad * 102.9372 + Math.PI;
    const dec = Math.asin(Math.sin(L) * Math.sin(rad * 23.4397));
    const jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    const cosW = (Math.sin(-0.833 * rad) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
    if (cosW > 1 || cosW < -1) return null; // polar night or day
    const w = Math.acos(cosW);
    const jset = J2000 + 0.0009 + (w + lw) / (2 * Math.PI) + n + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    const jrise = jnoon - (jset - jnoon);
    const toDate = (j) => new Date((j + 0.5 - J1970) * DAY_MS);
    return { rise: toDate(jrise), set: toDate(jset) };
  }

  const smooth = (t) => {
    t = Math.max(0, Math.min(1, t));
    return t * t * (3 - 2 * t);
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  const minutes = (d) => d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;

  // How far into the night hold we are: 0 awake, 1 fully held.
  function holdAmount(now) {
    const m = minutes(now);
    const start = HOLD.start * 60;
    const end = HOLD.end * 60;
    if (m < start || m >= end + HOLD.ramp) return 0;
    if (m < start + HOLD.ramp) return smooth((m - start) / HOLD.ramp);
    if (m < end) return 1;
    return 1 - smooth((m - end) / HOLD.ramp);
  }

  // 1 in full daylight, 0 at night, eased through dusk and dawn.
  function sunAmount(now, lat, lon) {
    const sun = sunTimes(now, lat, lon);
    if (!sun) return 1;
    const t = now.valueOf();
    const min = 60e3;
    const up = smooth((t - (sun.rise.valueOf() + DAWN[0] * min)) / ((DAWN[1] - DAWN[0]) * min));
    const down = smooth((t - (sun.set.valueOf() + DUSK[0] * min)) / ((DUSK[1] - DUSK[0]) * min));
    return Math.min(up, 1 - down);
  }

  /**
   * opts: {brightness (the remote's slider, 0..1), followSun, nightHold, lat, lon}
   * returns {level: backlight 0..1, motion: drift multiplier 0..1,
   *          night: night screen opacity 0..1, phase: label}
   */
  function at(now, opts) {
    const user = Math.max(0, Math.min(1, opts.brightness ?? 1));
    const s = opts.followSun ? sunAmount(now, opts.lat, opts.lon) : 1;
    const h = opts.nightHold ? holdAmount(now) : 0;
    const awake = user * lerp(LEVELS.evening, LEVELS.day, s);
    const level = lerp(awake, Math.min(awake, LEVELS.hold), h);

    let phase = "day";
    if (h >= 1) phase = "night hold";
    else if (h > 0) phase = minutes(now) < 12 * 60 && minutes(now) >= HOLD.end * 60 ? "waking" : "settling";
    else if (s <= 0) phase = now.getHours() >= 12 ? "evening" : "before dawn";
    else if (s < 1) phase = now.getHours() < 12 ? "dawn" : "dusk";
    return { level, motion: 1 - h, night: h, phase };
  }

  return { at, sunTimes, LEVELS, HOLD };
})();

if (typeof module !== "undefined") module.exports = Daylight;
