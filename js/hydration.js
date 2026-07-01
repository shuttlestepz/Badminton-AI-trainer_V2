/**
 * Shuttlestepz Hydration Engine
 * - calculateHydrationPlan(): pre/during/post fluid targets
 * - HydrationReminder: schedules "during session" reminders, ties into trainer loop
 *
 * Usage:
 *   const plan = HydrationEngine.calculateHydrationPlan({ weightKg: 70, durationMin: 45, intensity: 'intense', tempC: 34 });
 *   const reminder = new HydrationEngine.HydrationReminder(plan, (msg) => showToast(msg));
 *   reminder.start();   // call when session starts
 *   reminder.stop();    // call when session ends
 */

(function (global) {
  const INTENSITY_MULTIPLIER = {
    light: 0.8,
    moderate: 1.0,
    intense: 1.3
  };

  // Bump fluid needs when it's hot — relevant for Hyderabad-style conditions
  function heatFactor(tempC) {
    if (tempC == null) return 1.0;
    if (tempC >= 35) return 1.25;
    if (tempC >= 30) return 1.15;
    if (tempC >= 25) return 1.05;
    return 1.0;
  }

  /**
   * @param {Object} params
   * @param {number} params.weightKg
   * @param {number} params.durationMin
   * @param {'light'|'moderate'|'intense'} params.intensity
   * @param {number} [params.tempC] - optional, ambient temp in Celsius
   * @returns {Object} plan
   */
  function calculateHydrationPlan({ weightKg, durationMin, intensity = 'moderate', tempC }) {
    if (!weightKg || weightKg <= 0) throw new Error('weightKg must be a positive number');
    if (!durationMin || durationMin <= 0) throw new Error('durationMin must be a positive number');

    const mult = INTENSITY_MULTIPLIER[intensity] ?? 1.0;
    const heat = heatFactor(tempC);

    // Pre-hydration: 5-7 ml/kg baseline, scaled by intensity/heat
    const preMl = Math.round(weightKg * 6 * mult * heat);

    // During: base 200-300ml per 15-20min block, scaled by intensity/heat
    const intervalMin = intensity === 'intense' ? 15 : 20;
    const perIntervalMl = Math.round(250 * mult * heat);
    const numIntervals = Math.max(1, Math.round(durationMin / intervalMin));

    // Post: sweat-loss estimate ~ (weight-based rate) x duration x mult x heat, replace at 150%
    const sweatRateMlPerMin = 10 * mult * heat; // rough estimate, ml/min
    const estimatedSweatLossMl = Math.round(sweatRateMlPerMin * durationMin);
    const postMl = Math.round(estimatedSweatLossMl * 1.5);

    return {
      preMl,
      duringPerIntervalMl: perIntervalMl,
      duringIntervalMin: intervalMin,
      duringTotalMl: perIntervalMl * numIntervals,
      postMl,
      estimatedSweatLossMl,
      totalMl: preMl + (perIntervalMl * numIntervals) + postMl,
      meta: { weightKg, durationMin, intensity, tempC: tempC ?? null }
    };
  }

  /**
   * Schedules recurring reminders during an active session.
   * Wire start()/stop() into your existing session start/end handlers in trainer.js
   */
  class HydrationReminder {
    /**
     * @param {Object} plan - result of calculateHydrationPlan
     * @param {(message: string, data: Object) => void} onReminder - callback fired each interval
     */
    constructor(plan, onReminder) {
      this.plan = plan;
      this.onReminder = onReminder;
      this._timerId = null;
      this._elapsedIntervals = 0;
    }

    start() {
      this.stop(); // clear any existing timer
      this._elapsedIntervals = 0;
      const intervalMs = this.plan.duringIntervalMin * 60 * 1000;

      this._timerId = setInterval(() => {
        this._elapsedIntervals += 1;
        const message = `Hydration check: drink ${this.plan.duringPerIntervalMl}ml now`;
        this.onReminder(message, {
          intervalNumber: this._elapsedIntervals,
          amountMl: this.plan.duringPerIntervalMl
        });
      }, intervalMs);
    }

    stop() {
      if (this._timerId) {
        clearInterval(this._timerId);
        this._timerId = null;
      }
    }
  }

  global.HydrationEngine = { calculateHydrationPlan, HydrationReminder };
})(window);
