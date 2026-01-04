/**
 * Tests for the CardTracker constraint solver
 *
 * Run with: node tests.js
 */

'use strict';

const { CardTracker, Hand, GameState, RESOURCES, BUILDING_COSTS } = require('./card-tracker');
const { GameSimulator, runSimulationTest, runManySimulations } = require('./simulator');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    passCount++;
    console.log(`  ✓ ${message}`);
  } else {
    failCount++;
    console.log(`  ✗ ${message}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  const diff = Math.abs(actual - expected);
  if (diff <= tolerance) {
    passCount++;
    console.log(`  ✓ ${message} (${actual.toFixed(3)} ≈ ${expected.toFixed(3)})`);
  } else {
    failCount++;
    console.log(`  ✗ ${message} (${actual.toFixed(3)} ≠ ${expected.toFixed(3)}, diff=${diff.toFixed(3)})`);
  }
}

function assertInRange(value, min, max, message) {
  if (value >= min && value <= max) {
    passCount++;
    console.log(`  ✓ ${message} (${value} in [${min}, ${max}])`);
  } else {
    failCount++;
    console.log(`  ✗ ${message} (${value} not in [${min}, ${max}])`);
  }
}

// ============================================
// Unit Tests for Hand class
// ============================================

function testHand() {
  console.log('\n=== Hand Class Tests ===');

  const hand = new Hand();
  assert(hand.total() === 0, 'Empty hand has 0 cards');

  const hand2 = hand.add('wood', 3);
  assert(hand2.get('wood') === 3, 'Add 3 wood');
  assert(hand2.total() === 3, 'Total is 3');
  assert(hand.total() === 0, 'Original hand unchanged (immutable)');

  const hand3 = hand2.subtract('wood', 1);
  assert(hand3.get('wood') === 2, 'Subtract 1 wood');

  const hand4 = hand3.add('ore', 2).add('sheep', 1);
  assert(hand4.total() === 5, 'Multiple adds');
  assert(hand4.isValid(), 'Valid hand');

  const invalidHand = hand.subtract('wood', 1);
  assert(!invalidHand.isValid(), 'Negative count is invalid');

  assert(hand2.equals(new Hand([3, 0, 0, 0, 0])), 'Equality check');
  assert(!hand2.equals(hand3), 'Inequality check');
}

// ============================================
// Unit Tests for GameState class
// ============================================

function testGameState() {
  console.log('\n=== GameState Class Tests ===');

  const state = new GameState(4);
  assert(state.playerCount === 4, 'Player count');
  assert(state.hands.size === 4, 'All hands initialized');
  assert(state.probability === 1.0, 'Initial probability');

  const hand1 = state.getHand(1);
  assert(hand1.total() === 0, 'Initial hand is empty');

  const newState = state.setHand(1, new Hand([1, 1, 1, 1, 0]));
  assert(newState.getHand(1).total() === 4, 'Set hand works');
  assert(state.getHand(1).total() === 0, 'Original state unchanged');

  assert(newState.isValid(), 'Valid state');
  assert(newState.isValid({ cardCounts: { 1: 4 } }), 'Valid with card count constraint');
  assert(!newState.isValid({ cardCounts: { 1: 5 } }), 'Invalid with wrong card count');
}

// ============================================
// Unit Tests for CardTracker - Deterministic Events
// ============================================

function testProduction() {
  console.log('\n=== Production Tests ===');

  const tracker = new CardTracker(4);

  tracker.processProduction({
    1: { wood: 2, brick: 1 },
    2: { sheep: 3 },
    3: { wheat: 1, ore: 2 }
  });

  const m1 = tracker.getMarginals(1);
  assert(m1.wood.expected === 2, 'Player 1 got 2 wood');
  assert(m1.brick.expected === 1, 'Player 1 got 1 brick');
  assert(m1.total.expected === 3, 'Player 1 total 3');

  const m2 = tracker.getMarginals(2);
  assert(m2.sheep.expected === 3, 'Player 2 got 3 sheep');

  const m3 = tracker.getMarginals(3);
  assert(m3.wheat.expected === 1, 'Player 3 got 1 wheat');
  assert(m3.ore.expected === 2, 'Player 3 got 2 ore');

  assert(tracker.worlds.length === 1, 'Still 1 world (deterministic)');
}

function testBuilding() {
  console.log('\n=== Building Tests ===');

  const tracker = new CardTracker(4);

  // Give player 1 resources to build
  tracker.processProduction({
    1: { wood: 5, brick: 5, sheep: 2, wheat: 3, ore: 4 }
  });

  const beforeBuild = tracker.getMarginals(1);
  assert(beforeBuild.total.expected === 19, 'Before build: 19 cards');

  // Build a road
  tracker.processBuild(1, 'road');
  const afterRoad = tracker.getMarginals(1);
  assert(afterRoad.wood.expected === 4, 'After road: 4 wood');
  assert(afterRoad.brick.expected === 4, 'After road: 4 brick');
  assert(afterRoad.total.expected === 17, 'After road: 17 cards');

  // Build a settlement
  tracker.processBuild(1, 'settlement');
  const afterSettlement = tracker.getMarginals(1);
  assert(afterSettlement.wood.expected === 3, 'After settlement: 3 wood');
  assert(afterSettlement.brick.expected === 3, 'After settlement: 3 brick');
  assert(afterSettlement.sheep.expected === 1, 'After settlement: 1 sheep');
  assert(afterSettlement.wheat.expected === 2, 'After settlement: 2 wheat');
  assert(afterSettlement.total.expected === 13, 'After settlement: 13 cards');

  // Build a city
  tracker.processBuild(1, 'city');
  const afterCity = tracker.getMarginals(1);
  assert(afterCity.ore.expected === 1, 'After city: 1 ore');
  assert(afterCity.wheat.expected === 0, 'After city: 0 wheat');
  assert(afterCity.total.expected === 8, 'After city: 8 cards');

  assert(tracker.worlds.length === 1, 'Still 1 world (deterministic)');
}

function testBankTrade() {
  console.log('\n=== Bank Trade Tests ===');

  const tracker = new CardTracker(4);

  tracker.processProduction({
    1: { wood: 6 }
  });

  tracker.processBankTrade(1, { wood: 4 }, { ore: 1 });

  const m = tracker.getMarginals(1);
  assert(m.wood.expected === 2, 'After trade: 2 wood');
  assert(m.ore.expected === 1, 'After trade: 1 ore');
  assert(m.total.expected === 3, 'After trade: 3 cards');

  assert(tracker.worlds.length === 1, 'Still 1 world');
}

function testPlayerTrade() {
  console.log('\n=== Player Trade Tests ===');

  const tracker = new CardTracker(4);

  tracker.processProduction({
    1: { wood: 3 },
    2: { ore: 2 }
  });

  tracker.processPlayerTrade(1, { wood: 1 }, 2, { ore: 1 });

  const m1 = tracker.getMarginals(1);
  assert(m1.wood.expected === 2, 'Player 1 after trade: 2 wood');
  assert(m1.ore.expected === 1, 'Player 1 after trade: 1 ore');

  const m2 = tracker.getMarginals(2);
  assert(m2.wood.expected === 1, 'Player 2 after trade: 1 wood');
  assert(m2.ore.expected === 1, 'Player 2 after trade: 1 ore');
}

function testDiscard() {
  console.log('\n=== Discard Tests ===');

  const tracker = new CardTracker(4);

  tracker.processProduction({
    1: { wood: 5, brick: 3 }
  });

  tracker.processDiscard(1, { wood: 2, brick: 1 });

  const m = tracker.getMarginals(1);
  assert(m.wood.expected === 3, 'After discard: 3 wood');
  assert(m.brick.expected === 2, 'After discard: 2 brick');
  assert(m.total.expected === 5, 'After discard: 5 cards');
}

function testMonopoly() {
  console.log('\n=== Monopoly Tests ===');

  const tracker = new CardTracker(4);

  tracker.processProduction({
    1: { wood: 2 },
    2: { wood: 3 },
    3: { wood: 1 }
  });

  // Player 4 plays monopoly on wood
  tracker.processMonopoly(4, 'wood', { 1: 2, 2: 3, 3: 1 });

  const m1 = tracker.getMarginals(1);
  assert(m1.wood.expected === 0, 'Player 1 has 0 wood');

  const m4 = tracker.getMarginals(4);
  assert(m4.wood.expected === 6, 'Player 4 has 6 wood');
}

function testYearOfPlenty() {
  console.log('\n=== Year of Plenty Tests ===');

  const tracker = new CardTracker(4);

  tracker.processYearOfPlenty(1, { wood: 1, ore: 1 });

  const m = tracker.getMarginals(1);
  assert(m.wood.expected === 1, 'Got 1 wood');
  assert(m.ore.expected === 1, 'Got 1 ore');
  assert(m.total.expected === 2, 'Total 2 cards');
}

// ============================================
// Unit Tests for CardTracker - Probabilistic Events (Steals)
// ============================================

function testSimpleSteal() {
  console.log('\n=== Simple Steal Tests ===');

  const tracker = new CardTracker(4);

  // Player 2 has 2 wood, 1 brick
  tracker.processProduction({
    2: { wood: 2, brick: 1 }
  });

  // Player 1 steals from player 2
  tracker.processSteal(1, 2);

  assert(tracker.worlds.length === 2, 'Steal creates 2 worlds (wood or brick)');

  const m1 = tracker.getMarginals(1);
  // Expected: 2/3 chance wood, 1/3 chance brick
  assertClose(m1.wood.expected, 2 / 3, 0.01, 'Player 1 expected wood');
  assertClose(m1.brick.expected, 1 / 3, 0.01, 'Player 1 expected brick');
  assert(m1.total.expected === 1, 'Player 1 total 1 card');

  const m2 = tracker.getMarginals(2);
  assertClose(m2.wood.expected, 2 - 2 / 3, 0.01, 'Player 2 expected wood');
  assertClose(m2.brick.expected, 1 - 1 / 3, 0.01, 'Player 2 expected brick');
  assert(m2.total.expected === 2, 'Player 2 total 2 cards');
}

function testMultipleSteals() {
  console.log('\n=== Multiple Steals Tests ===');

  const tracker = new CardTracker(4);

  tracker.processProduction({
    2: { wood: 2, brick: 2 }
  });

  // Two steals from player 2
  tracker.processSteal(1, 2);
  tracker.processSteal(1, 2);

  // With 2 wood, 2 brick: first steal is 50/50
  // After first steal, could be 1w2b, 2w1b
  // Second steal branches further
  assert(tracker.worlds.length > 2, 'Multiple steals create more worlds');

  const m1 = tracker.getMarginals(1);
  assertClose(m1.total.expected, 2, 0.01, 'Thief has 2 cards');

  const m2 = tracker.getMarginals(2);
  assertClose(m2.total.expected, 2, 0.01, 'Victim has 2 cards');
}

function testStealFromEmptyHand() {
  console.log('\n=== Steal from Empty Hand Tests ===');

  const tracker = new CardTracker(4);

  // Player 2 has no cards
  tracker.processSteal(1, 2);

  const m1 = tracker.getMarginals(1);
  assert(m1.total.expected === 0, 'Cannot steal from empty hand');

  assert(tracker.worlds.length === 1, 'No branching for empty steal');
}

function testBuildPrunesWorlds() {
  console.log('\n=== Build Prunes Worlds Tests ===');

  const tracker = new CardTracker(4);

  // Player 1 has exactly enough for a road
  tracker.processProduction({
    1: { wood: 1, brick: 1 }
  });

  // Player 2 steals - creates uncertainty
  tracker.processSteal(2, 1);

  const worldsBefore = tracker.worlds.length;
  assert(worldsBefore === 2, 'Steal created 2 worlds');

  // Now player 1 builds a road - this proves they still have wood AND brick
  // So the steal must have been... nothing? But they have 2 cards, steal takes 1
  // Actually, if steal happened, player 1 has 1 card, can't build road

  // Let me redo this test more carefully...
}

function testBuildAsProofOfExistence() {
  console.log('\n=== Build as Proof of Existence Tests ===');

  const tracker = new CardTracker(4);

  // Player 1 has 2 wood, 2 brick, 1 ore
  tracker.processProduction({
    1: { wood: 2, brick: 2, ore: 1 }
  });

  // Player 2 steals from player 1
  // Could steal: wood (2/5), brick (2/5), ore (1/5)
  tracker.processSteal(2, 1);

  assert(tracker.worlds.length === 3, 'Three possible steal outcomes');

  // Now player 1 builds TWO roads (needs 2 wood, 2 brick)
  // This is only possible if ore was stolen!
  tracker.processBuild(1, 'road');
  tracker.processBuild(1, 'road');

  // After pruning invalid worlds, only ore-stolen world survives
  const m1 = tracker.getMarginals(1);
  assert(m1.wood.expected === 0, 'Player 1 has 0 wood after 2 roads');
  assert(m1.brick.expected === 0, 'Player 1 has 0 brick after 2 roads');
  assert(m1.ore.expected === 0, 'Player 1 has 0 ore (was stolen)');

  const m2 = tracker.getMarginals(2);
  assert(m2.ore.expected === 1, 'Player 2 must have stolen ore');
  assert(m2.wood.expected === 0, 'Player 2 has 0 wood');
  assert(m2.brick.expected === 0, 'Player 2 has 0 brick');

  assert(tracker.worlds.length === 1, 'Only one world survives pruning');
}

// ============================================
// Simulation Tests
// ============================================

function testSimulation() {
  console.log('\n=== Simulation Tests ===');

  // Run a few simulations and check basic properties
  for (let i = 0; i < 5; i++) {
    const result = runSimulationTest({
      playerCount: 4,
      numTurns: 20,
      verbose: false
    });

    assert(result.worlds >= 1, `Sim ${i + 1}: At least 1 world`);
    assert(result.meanAbsoluteError < 10, `Sim ${i + 1}: MAE < 10`);
  }
}

function testSimulationAccuracy() {
  console.log('\n=== Simulation Accuracy Tests ===');

  const result = runManySimulations(50, {
    playerCount: 4,
    numTurns: 25
  });

  assertInRange(result.successRate, 0.5, 1.0, 'Success rate reasonable');
  assertInRange(result.avgMAE, 0, 3, 'Average MAE low');
}

// ============================================
// Edge Cases
// ============================================

function testEdgeCases() {
  console.log('\n=== Edge Case Tests ===');

  // Test with just 2 players
  const tracker2 = new CardTracker(2);
  tracker2.processProduction({ 1: { wood: 5 }, 2: { brick: 5 } });
  tracker2.processSteal(1, 2);
  assert(tracker2.worlds.length === 1, '2 players, uniform hand, 1 world');

  // Test world limit
  const trackerLimit = new CardTracker(4, { maxWorlds: 5 });
  trackerLimit.processProduction({ 1: { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 1 } });
  trackerLimit.processSteal(2, 1);
  trackerLimit.processSteal(3, 1);
  trackerLimit.processSteal(4, 1);
  assert(trackerLimit.worlds.length <= 5, 'World count respects limit');

  // Test probability renormalization
  const probs = trackerLimit.worlds.map(w => w.probability);
  const sum = probs.reduce((a, b) => a + b, 0);
  assertClose(sum, 1.0, 0.001, 'Probabilities sum to 1');
}

function testBankConstraint() {
  console.log('\n=== Bank Constraint Tests ===');

  const tracker = new CardTracker(4);

  // Set bank visible
  tracker.setBank({
    wood: 17, brick: 19, sheep: 19, wheat: 19, ore: 19
  });

  // Players must have 2 wood total
  tracker.processProduction({
    1: { wood: 1 },
    2: { wood: 1 }
  });

  const m1 = tracker.getMarginals(1);
  assert(m1.wood.expected === 1, 'Bank constraint: player 1 has 1 wood');

  // If we try to give more wood than exists...
  // (The simulator should prevent this, but tracker should handle gracefully)
}

function testCardCountConstraint() {
  console.log('\n=== Card Count Constraint Tests ===');

  const tracker = new CardTracker(4);

  tracker.processProduction({
    1: { wood: 2, brick: 2 }
  });

  // Player 2 steals
  tracker.processSteal(2, 1);

  // Now set card count constraint - player 1 has 3 cards
  tracker.setCardCount(1, 3);

  const m1 = tracker.getMarginals(1);
  assertClose(m1.total.expected, 3, 0.01, 'Card count constraint enforced');
}

// ============================================
// Cities & Knights Tests
// ============================================

function testCKProduction() {
  console.log('\n=== C&K Production Tests ===');

  const tracker = new CardTracker(4, { citiesAndKnights: true });

  // C&K production includes commodities
  tracker.processProduction({
    1: { wood: 2, cloth: 1 },
    2: { ore: 1, coin: 2 }
  });

  const m1 = tracker.getMarginals(1);
  assert(m1.wood.expected === 2, 'Player 1 got 2 wood');
  assert(m1.cloth.expected === 1, 'Player 1 got 1 cloth');
  assert(m1.total.expected === 3, 'Player 1 total 3');
  assert(m1.totalResources.expected === 2, 'Player 1 has 2 resources');
  assert(m1.totalCommodities.expected === 1, 'Player 1 has 1 commodity');

  const m2 = tracker.getMarginals(2);
  assert(m2.ore.expected === 1, 'Player 2 got 1 ore');
  assert(m2.coin.expected === 2, 'Player 2 got 2 coin');
}

function testCKSteal() {
  console.log('\n=== C&K Steal Tests ===');

  const tracker = new CardTracker(4, { citiesAndKnights: true });

  // Player 2 has resources and commodities
  tracker.processProduction({
    2: { wood: 1, cloth: 1, coin: 1 }
  });

  // Player 1 steals - could get any of the 3 card types
  tracker.processSteal(1, 2);

  assert(tracker.worlds.length === 3, 'C&K steal creates 3 worlds');

  const m1 = tracker.getMarginals(1);
  assertClose(m1.wood.expected, 1 / 3, 0.01, 'Player 1 expected wood');
  assertClose(m1.cloth.expected, 1 / 3, 0.01, 'Player 1 expected cloth');
  assertClose(m1.coin.expected, 1 / 3, 0.01, 'Player 1 expected coin');
}

function testCKMasterMerchant() {
  console.log('\n=== C&K Master Merchant Tests ===');

  const tracker = new CardTracker(4, { citiesAndKnights: true });

  tracker.processProduction({
    2: { wood: 2, brick: 2 }
  });

  // Master merchant steals 2 cards
  tracker.processMasterMerchant(1, 2);

  const m1 = tracker.getMarginals(1);
  assertClose(m1.total.expected, 2, 0.01, 'Thief got 2 cards');

  const m2 = tracker.getMarginals(2);
  assertClose(m2.total.expected, 2, 0.01, 'Victim has 2 cards left');
}

function testCKWedding() {
  console.log('\n=== C&K Wedding Tests ===');

  const tracker = new CardTracker(4, { citiesAndKnights: true });

  tracker.processProduction({
    1: { wood: 3, brick: 2 },
    2: { sheep: 4 }
  });

  // Player 3 plays wedding, receives gifts from 1 and 2
  tracker.processWedding(3, {
    1: { wood: 1, brick: 1 },
    2: { sheep: 2 }
  });

  const m1 = tracker.getMarginals(1);
  assert(m1.wood.expected === 2, 'Player 1 has 2 wood after wedding');
  assert(m1.brick.expected === 1, 'Player 1 has 1 brick after wedding');

  const m2 = tracker.getMarginals(2);
  assert(m2.sheep.expected === 2, 'Player 2 has 2 sheep after wedding');

  const m3 = tracker.getMarginals(3);
  assert(m3.wood.expected === 1, 'Player 3 got 1 wood');
  assert(m3.brick.expected === 1, 'Player 3 got 1 brick');
  assert(m3.sheep.expected === 2, 'Player 3 got 2 sheep');
}

function testCKBuildKnight() {
  console.log('\n=== C&K Knight Building Tests ===');

  const tracker = new CardTracker(4, { citiesAndKnights: true });

  tracker.processProduction({
    1: { sheep: 2, ore: 2 }
  });

  tracker.processBuild(1, 'knight');

  const m = tracker.getMarginals(1);
  assert(m.sheep.expected === 1, 'After knight: 1 sheep');
  assert(m.ore.expected === 1, 'After knight: 1 ore');
}

// ============================================
// Stress Tests
// ============================================

function testStress() {
  console.log('\n=== Stress Tests ===');

  // Many steals
  const tracker = new CardTracker(4);

  // Give everyone lots of cards
  for (let i = 0; i < 10; i++) {
    tracker.processProduction({
      1: { wood: 1, brick: 1 },
      2: { sheep: 1, wheat: 1 },
      3: { ore: 1, wood: 1 },
      4: { brick: 1, sheep: 1 }
    });
  }

  // Many steals
  for (let i = 0; i < 15; i++) {
    const thief = (i % 4) + 1;
    const victim = ((i + 2) % 4) + 1;
    tracker.processSteal(thief, victim);
  }

  assert(tracker.worlds.length <= tracker.maxWorlds, 'World count bounded');

  const probs = tracker.worlds.map(w => w.probability);
  const sum = probs.reduce((a, b) => a + b, 0);
  assertClose(sum, 1.0, 0.001, 'Probabilities still sum to 1 after many steals');

  // Can still get marginals
  for (let p = 1; p <= 4; p++) {
    const m = tracker.getMarginals(p);
    assert(m.total.expected >= 0, `Player ${p} has non-negative cards`);
  }
}

function testLongGame() {
  console.log('\n=== Long Game Test ===');

  const result = runSimulationTest({
    playerCount: 4,
    numTurns: 100,
    verbose: false
  });

  assert(result.worlds >= 1, 'Long game has valid worlds');
  assert(result.meanAbsoluteError < 15, 'Long game MAE reasonable');
}

// ============================================
// Run All Tests
// ============================================

function runAllTests() {
  console.log('Starting CardTracker Tests...\n');

  // Unit tests
  testHand();
  testGameState();
  testProduction();
  testBuilding();
  testBankTrade();
  testPlayerTrade();
  testDiscard();
  testMonopoly();
  testYearOfPlenty();

  // Probabilistic tests
  testSimpleSteal();
  testMultipleSteals();
  testStealFromEmptyHand();
  testBuildAsProofOfExistence();

  // Constraint tests
  testBankConstraint();
  testCardCountConstraint();

  // Cities & Knights tests
  testCKProduction();
  testCKSteal();
  testCKMasterMerchant();
  testCKWedding();
  testCKBuildKnight();

  // Edge cases
  testEdgeCases();

  // Stress tests
  testStress();

  // Simulation tests
  testSimulation();
  testLongGame();
  testSimulationAccuracy();

  // Summary
  console.log('\n========================================');
  console.log(`Tests complete: ${passCount} passed, ${failCount} failed`);
  console.log('========================================\n');

  return failCount === 0;
}

// Run tests
const success = runAllTests();
process.exit(success ? 0 : 1);
