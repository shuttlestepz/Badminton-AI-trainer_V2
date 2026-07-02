// plans.js — ShuttleStepz combined Diet + Hydration + Workout engines
// Single-file bundle of DietEngine, HydrationEngine, WorkoutEngine.
// Include with: <script src="plans.js"></script>
// (replaces separate diet.js / hydration.js / workout.js includes)

// diet.js — ShuttleStepz Diet Engine
// Exposes window.DietEngine.calculateDietPlan({ weightKg, heightCm, age, sex, trainingDaysPerWeek, goal })

(function (global) {
  'use strict';

  // Mifflin-St Jeor BMR
  function calculateBMR({ weightKg, heightCm, age, sex }) {
    const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
    return sex === 'female' ? base - 161 : base + 5;
  }

  // Activity multiplier scaled to training days/week (badminton sessions)
  function activityMultiplier(trainingDaysPerWeek) {
    if (trainingDaysPerWeek <= 0) return 1.2;   // sedentary
    if (trainingDaysPerWeek <= 2) return 1.375; // light
    if (trainingDaysPerWeek <= 4) return 1.55;  // moderate
    if (trainingDaysPerWeek <= 6) return 1.725; // high
    return 1.9;                                 // very high (daily+)
  }

  // Calorie adjustment by goal
  function goalAdjustment(goal) {
    switch (goal) {
      case 'lean': return 0.85;   // ~15% deficit
      case 'gain': return 1.12;   // ~12% surplus
      case 'maintain':
      default: return 1.0;
    }
  }

  // Protein target (g/kg bodyweight) — athletes need more than sedentary RDA
  function proteinPerKg(goal) {
    switch (goal) {
      case 'lean': return 2.0;   // higher protein preserves muscle in deficit
      case 'gain': return 1.8;
      case 'maintain':
      default: return 1.6;
    }
  }

  // Fat target (g/kg bodyweight) — floor for hormone health
  function fatPerKg() {
    return 0.9;
  }

  function calculateDietPlan({ weightKg, heightCm, age, sex, trainingDaysPerWeek, goal }) {
    const bmr = calculateBMR({ weightKg, heightCm, age, sex });
    const tdee = bmr * activityMultiplier(trainingDaysPerWeek);
    const targetCalories = Math.round(tdee * goalAdjustment(goal));

    const proteinG = Math.round(weightKg * proteinPerKg(goal));
    const fatG = Math.round(weightKg * fatPerKg());

    const proteinCal = proteinG * 4;
    const fatCal = fatG * 9;
    const remainingCal = Math.max(0, targetCalories - proteinCal - fatCal);
    const carbG = Math.round(remainingCal / 4);

    return {
      targetCalories,
      bmr: Math.round(bmr),
      tdee: Math.round(tdee),
      macros: { proteinG, carbG, fatG }
    };
  }

  global.DietEngine = { calculateDietPlan };
})(window);

// hydration.js — ShuttleStepz Hydration Engine
// Exposes window.HydrationEngine.calculateHydrationPlan({ weightKg, durationMin, intensity, tempC })
// Exposes window.HydrationEngine.HydrationReminder(plan, onReminder)

(function (global) {
  'use strict';

  // Estimated sweat/fluid loss rate in ml per hour, by intensity
  function sweatRateMlPerHour(intensity) {
    switch (intensity) {
      case 'light': return 400;
      case 'intense': return 900;
      case 'moderate':
      default: return 650;
    }
  }

  // Extra ml/hour added per degree above 28°C (heat stress bump)
  function tempAdjustmentMlPerHour(tempC) {
    if (tempC === undefined || tempC === null || isNaN(tempC)) return 0;
    const excess = tempC - 28;
    if (excess <= 0) return 0;
    return Math.round(excess * 15); // +15ml/hr per degree over 28°C
  }

  function calculateHydrationPlan({ weightKg, durationMin, intensity, tempC }) {
    const hours = durationMin / 60;
    const baseRate = sweatRateMlPerHour(intensity) + tempAdjustmentMlPerHour(tempC);

    // During-session total loss estimate
    const duringTotalMl = Math.round(baseRate * hours);

    // Pre-hydration: ~5ml/kg bodyweight, 2-3 hrs before
    const preMl = Math.round(weightKg * 5);

    // Interval for sipping during play (shorter for intense/hot sessions)
    let duringIntervalMin = 20;
    if (intensity === 'intense' || (tempC && tempC > 32)) duringIntervalMin = 15;
    if (intensity === 'light') duringIntervalMin = 25;

    const numIntervals = Math.max(1, Math.round(durationMin / duringIntervalMin));
    const duringPerIntervalMl = Math.round(duringTotalMl / numIntervals);

    // Post-session: replace 125% of estimated loss (accounts for ongoing sweat loss after stopping)
    const postMl = Math.round(duringTotalMl * 0.5);

    const totalMl = preMl + duringTotalMl + postMl;

    return {
      totalMl,
      preMl,
      duringTotalMl,
      duringPerIntervalMl,
      duringIntervalMin,
      postMl
    };
  }

  // Fires a reminder callback every duringIntervalMin, with a sip amount message.
  function HydrationReminder(plan, onReminder) {
    this.plan = plan;
    this.onReminder = onReminder;
    this._timerId = null;
  }

  HydrationReminder.prototype.start = function () {
    this.stop(); // clear any existing timer
    const intervalMs = this.plan.duringIntervalMin * 60 * 1000;
    this._timerId = setInterval(() => {
      this.onReminder(`💧 Drink ${this.plan.duringPerIntervalMl} ml now`);
    }, intervalMs);
  };

  HydrationReminder.prototype.stop = function () {
    if (this._timerId) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
  };

  global.HydrationEngine = { calculateHydrationPlan, HydrationReminder };
})(window);

// workout.js — ShuttleStepz Workout Engine
// Exposes window.WorkoutEngine.generatePlan({ goal, daysPerWeek, level })

(function (global) {
  'use strict';

  // Sets/reps multiplier by level
  const LEVEL_SCALE = {
    beginner: { sets: 2, repsLabel: 'lower reps', mult: 0.8 },
    intermediate: { sets: 3, repsLabel: 'standard reps', mult: 1.0 },
    advanced: { sets: 4, repsLabel: 'higher reps', mult: 1.2 }
  };

  // Focus rotation per goal — cycles based on daysPerWeek
  const FOCUS_ROTATIONS = {
    agility: ['Footwork & Court Speed', 'Reactive Agility', 'Lateral Power', 'Core & Balance', 'Recovery Mobility', 'Full Court Circuit'],
    strength: ['Lower Body Power', 'Upper Body & Core', 'Explosive Strength', 'Posterior Chain', 'Active Recovery', 'Full Body Strength'],
    endurance: ['Aerobic Base', 'Interval Conditioning', 'Match Endurance', 'Core Stability', 'Active Recovery', 'Long Court Sprints']
  };

  // Exercise pools keyed by goal + focus type (footwork/strength/endurance/core/mobility)
  const EXERCISE_LIBRARY = {
    agility: {
      'Footwork & Court Speed': [
        { name: 'Shadow badminton footwork', reps: '4 x 30s' },
        { name: 'Six-corner court touches', reps: '5 rounds' },
        { name: 'Split-step drills', reps: '3 x 20 reps' }
      ],
      'Reactive Agility': [
        { name: 'Reaction ball drills', reps: '4 x 15 reps' },
        { name: 'Mirror drills with partner', reps: '3 x 45s' },
        { name: 'Cone reaction sprints', reps: '5 rounds' }
      ],
      'Lateral Power': [
        { name: 'Lateral bounds', reps: '3 x 10 reps/side' },
        { name: 'Side shuffle with resistance band', reps: '3 x 20m' },
        { name: 'Crossover step drills', reps: '3 x 15 reps' }
      ],
      'Core & Balance': [
        { name: 'Single-leg balance reach', reps: '3 x 10 reps/side' },
        { name: 'Plank with shoulder taps', reps: '3 x 20 taps' },
        { name: 'Bosu ball squats', reps: '3 x 12 reps' }
      ],
      'Recovery Mobility': [
        { name: 'Hip flexor mobility flow', reps: '3 x 30s/side' },
        { name: 'Ankle circles & calf stretch', reps: '2 x 30s/side' },
        { name: 'Foam rolling — legs & back', reps: '10 min' }
      ],
      'Full Court Circuit': [
        { name: 'Full-court shadow rally', reps: '5 x 40s' },
        { name: 'Multi-shuttle feed footwork', reps: '4 rounds' },
        { name: 'Star drill', reps: '4 rounds' }
      ]
    },
    strength: {
      'Lower Body Power': [
        { name: 'Barbell/bodyweight squats', reps: '4 x 8 reps' },
        { name: 'Bulgarian split squats', reps: '3 x 10 reps/side' },
        { name: 'Box jumps', reps: '4 x 6 reps' }
      ],
      'Upper Body & Core': [
        { name: 'Push-ups', reps: '3 x 12 reps' },
        { name: 'Dumbbell rows', reps: '3 x 10 reps/side' },
        { name: 'Plank hold', reps: '3 x 45s' }
      ],
      'Explosive Strength': [
        { name: 'Jump squats', reps: '4 x 8 reps' },
        { name: 'Medicine ball slams', reps: '4 x 10 reps' },
        { name: 'Broad jumps', reps: '3 x 6 reps' }
      ],
      'Posterior Chain': [
        { name: 'Romanian deadlifts', reps: '4 x 8 reps' },
        { name: 'Glute bridges', reps: '3 x 15 reps' },
        { name: 'Nordic hamstring curls', reps: '3 x 6 reps' }
      ],
      'Active Recovery': [
        { name: 'Light mobility circuit', reps: '15 min' },
        { name: 'Banded shoulder work', reps: '2 x 15 reps' },
        { name: 'Stretching — full body', reps: '10 min' }
      ],
      'Full Body Strength': [
        { name: 'Deadlifts', reps: '4 x 6 reps' },
        { name: 'Overhead press', reps: '3 x 8 reps' },
        { name: 'Weighted step-ups', reps: '3 x 10 reps/side' }
      ]
    },
    endurance: {
      'Aerobic Base': [
        { name: 'Steady-state jog', reps: '25 min' },
        { name: 'Skipping rope', reps: '4 x 3 min' },
        { name: 'Cycling — moderate pace', reps: '20 min' }
      ],
      'Interval Conditioning': [
        { name: 'Shuttle sprints', reps: '8 x 30s on/30s off' },
        { name: 'Bike sprints', reps: '6 x 20s on/40s off' },
        { name: 'Burpee intervals', reps: '5 x 45s' }
      ],
      'Match Endurance': [
        { name: 'Simulated multi-game rally drills', reps: '3 x 15 min' },
        { name: 'On-court conditioning circuit', reps: '4 rounds' },
        { name: 'Continuous feed & clear drill', reps: '20 min' }
      ],
      'Core Stability': [
        { name: 'Plank variations', reps: '3 x 40s' },
        { name: 'Russian twists', reps: '3 x 20 reps' },
        { name: 'Mountain climbers', reps: '3 x 30s' }
      ],
      'Active Recovery': [
        { name: 'Easy swim or walk', reps: '20 min' },
        { name: 'Dynamic stretching flow', reps: '10 min' },
        { name: 'Foam rolling', reps: '10 min' }
      ],
      'Long Court Sprints': [
        { name: 'Repeated court-length sprints', reps: '10 x 20m' },
        { name: 'Tempo runs', reps: '15 min' },
        { name: 'Suicide runs', reps: '6 rounds' }
      ]
    }
  };

  const NOTES = {
    agility: 'Focus on quick, light ground contact and staying low. Quality of movement matters more than speed early on — rest fully between reps.',
    strength: 'Prioritize form over load, especially as a beginner. Allow 48 hours between sessions targeting the same muscle groups.',
    endurance: 'Build volume gradually week to week. Keep easy days genuinely easy so hard days can be hard.'
  };

  function generatePlan({ goal, daysPerWeek, level }) {
    const rotation = FOCUS_ROTATIONS[goal] || FOCUS_ROTATIONS.agility;
    const library = EXERCISE_LIBRARY[goal] || EXERCISE_LIBRARY.agility;
    const scale = LEVEL_SCALE[level] || LEVEL_SCALE.intermediate;

    const days = Math.max(2, Math.min(6, Math.round(daysPerWeek)));
    const weeklyPlan = [];

    for (let i = 0; i < days; i++) {
      const focus = rotation[i % rotation.length];
      const pool = library[focus] || [];

      const exercises = pool.map(ex => ({
        name: ex.name,
        sets: scale.sets,
        reps: ex.reps
      }));

      weeklyPlan.push({
        day: i + 1,
        focus,
        exercises
      });
    }

    const note = `${NOTES[goal] || NOTES.agility} Sets shown reflect ${level} level (${scale.repsLabel}).`;

    return { weeklyPlan, note };
  }

  global.WorkoutEngine = { generatePlan };
})(window);
