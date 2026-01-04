# Card Tracker

Probabilistic inference engine for tracking opponent hands in Catan.

## Overview

This module uses constraint satisfaction with forward dynamic programming to estimate what cards each player holds, even with hidden information (steals).

### Key Concepts

1. **Multiple Worlds**: Maintains a set of possible game states, each representing a different outcome of hidden events (steals)

2. **Constraint Propagation**: Uses observable events (builds, trades, bank totals, card counts) to prune impossible worlds

3. **Probabilistic Inference**: Computes expected values and ranges for each resource in each player's hand

## Files

- `card-tracker.js` - Core tracker implementation
- `simulator.js` - Game simulator with ground truth for testing
- `tests.js` - Unit and integration tests
- `benchmark.js` - Performance benchmarks

## Usage

```javascript
const { CardTracker } = require('./card-tracker');

const tracker = new CardTracker(4); // 4 players

// Production (dice roll)
tracker.processProduction({
  1: { wood: 2, brick: 1 },
  2: { sheep: 3 }
});

// Build (also serves as proof-of-existence)
tracker.processBuild(1, 'road');  // road, settlement, city, devCard

// Trades
tracker.processBankTrade(1, { wood: 4 }, { ore: 1 });
tracker.processPlayerTrade(1, { wood: 1 }, 2, { sheep: 1 });

// Steal (this creates uncertainty - branches worlds)
tracker.processSteal(2, 1);  // player 2 steals from player 1

// Other events
tracker.processDiscard(1, { wood: 2 });
tracker.processMonopoly(3, 'ore', { 1: 2, 2: 1 });
tracker.processYearOfPlenty(1, { wood: 1, brick: 1 });

// Get estimates
const marginals = tracker.getMarginals(1);
// {
//   wood: { expected: 2.3, min: 1, max: 4, distribution: { 1: 0.2, 2: 0.5, ... } },
//   brick: { ... },
//   ...
//   total: { expected: 8, min: 6, max: 10 }
// }

// Confidence score (0-1)
const confidence = tracker.getConfidence(1);

// Apply constraints (if visible in game)
tracker.setBank({ wood: 15, brick: 17, sheep: 19, wheat: 18, ore: 16 });
tracker.setCardCount(1, 7);
```

## Performance

Benchmarks show:

| Scenario | Success Rate | MAE | Worlds | Time |
|----------|--------------|-----|--------|------|
| 20 turns | 100% | 0.20 | ~90 | 17ms |
| 40 turns | 100% | 0.33 | ~230 | 56ms |
| 60 turns | 100% | 0.41 | ~486 | 139ms |
| 80 turns | 95% | 0.44 | ~441 | 200ms |

- **Success Rate**: % of simulations where actual hands were within estimated ranges
- **MAE**: Mean Absolute Error per resource per player
- **Worlds**: Number of possible game states tracked
- **Time**: Total processing time for 20 simulations

## Algorithm

### Event Processing

1. **Deterministic events** (production, builds, trades): Update all worlds identically
2. **Steals**: Branch each world into N new worlds (one per possible stolen resource), weighted by probability
3. **After each event**: Merge identical worlds, prune low-probability ones, renormalize

### Constraint Pruning

When a player builds something, worlds where they couldn't afford it are eliminated:

```
Before steal: Player has [3 wood, 2 brick, 1 ore]
After steal:  Could be [2,2,1] or [3,1,1] or [3,2,0] - 3 worlds

Player builds 2 roads (requires 2 wood, 2 brick each)
Only [3,2,0] allows this - other worlds pruned!
Now we know the steal was ore.
```

### Bank Conservation

If bank totals are visible:
```
Bank + Σ(all hands) = 19 per resource
```

This global constraint helps bound estimates even with uncertainty.

## Testing

```bash
# Run all tests
node tests.js

# Run benchmarks
node benchmark.js
```

## Configuration

```javascript
const tracker = new CardTracker(4, {
  maxWorlds: 1000,      // Limit on tracked worlds (default: 1000)
  pruneThreshold: 0.0001 // Min probability to keep (default: 0.0001)
});
```

## Integration with PearsonRAE

To integrate with the main extension:

1. Parse game log events (builds, trades, steals) from `gameLogState`
2. Feed events to CardTracker
3. Display marginals in UI with confidence indicators

The tracker is designed to be deterministic and replayable - given the same event sequence, it produces identical results.
