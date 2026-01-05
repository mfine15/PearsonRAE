/**
 * Game Simulator - Generates random Catan games with known ground truth
 *
 * Used to test the CardTracker by comparing its estimates against
 * the actual hidden card states.
 */

'use strict';

const { RESOURCES, BUILDING_COSTS, TOTAL_PER_RESOURCE } = require('./card-tracker');

/**
 * Simulates a Catan game with full ground truth tracking
 */
class GameSimulator {
  constructor(playerCount = 4, options = {}) {
    this.playerCount = playerCount;
    this.options = {
      // Probability weights for different event types
      productionWeight: 0.5,
      buildWeight: 0.2,
      tradeWeight: 0.15,
      stealWeight: 0.1,
      discardWeight: 0.05,
      ...options
    };

    // Ground truth hands
    this.hands = {};
    for (let i = 1; i <= playerCount; i++) {
      this.hands[i] = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
    }

    // Bank state
    this.bank = {};
    for (const resource of RESOURCES) {
      this.bank[resource] = TOTAL_PER_RESOURCE;
    }

    // Event log
    this.events = [];
    this.turnNumber = 0;

    // Steal history (for verification)
    this.stealHistory = [];
  }

  /**
   * Get total cards for a player
   */
  getCardCount(playerId) {
    return Object.values(this.hands[playerId]).reduce((a, b) => a + b, 0);
  }

  /**
   * Pick a random resource from a hand, weighted by count
   */
  pickRandomResource(playerId) {
    const hand = this.hands[playerId];
    const total = this.getCardCount(playerId);
    if (total === 0) return null;

    let roll = Math.random() * total;
    for (const resource of RESOURCES) {
      roll -= hand[resource];
      if (roll <= 0) return resource;
    }
    return RESOURCES[RESOURCES.length - 1];
  }

  /**
   * Generate production event
   */
  generateProduction() {
    const productions = {};

    for (let i = 1; i <= this.playerCount; i++) {
      productions[i] = {};

      // Each player has some chance of getting each resource
      for (const resource of RESOURCES) {
        if (this.bank[resource] > 0 && Math.random() < 0.3) {
          const amount = Math.min(
            Math.floor(Math.random() * 3) + 1,
            this.bank[resource]
          );
          if (amount > 0) {
            productions[i][resource] = amount;
            this.hands[i][resource] += amount;
            this.bank[resource] -= amount;
          }
        }
      }

      // Remove empty productions
      if (Object.keys(productions[i]).length === 0) {
        delete productions[i];
      }
    }

    if (Object.keys(productions).length > 0) {
      this._pushEvent({
        type: 'production',
        turn: this.turnNumber,
        data: productions
      });
      return { type: 'production', data: productions };
    }
    return null;
  }

  /**
   * Generate build event
   */
  generateBuild() {
    // Pick a random player who can afford something
    const players = this._shuffle([...Array(this.playerCount).keys()].map(i => i + 1));

    for (const playerId of players) {
      const hand = this.hands[playerId];
      const buildOptions = [];

      for (const [building, cost] of Object.entries(BUILDING_COSTS)) {
        let canBuild = true;
        for (const [resource, amount] of Object.entries(cost)) {
          if (hand[resource] < amount) {
            canBuild = false;
            break;
          }
        }
        if (canBuild) buildOptions.push(building);
      }

      if (buildOptions.length > 0) {
        const building = buildOptions[Math.floor(Math.random() * buildOptions.length)];
        const cost = BUILDING_COSTS[building];

        // Execute build
        for (const [resource, amount] of Object.entries(cost)) {
          this.hands[playerId][resource] -= amount;
          this.bank[resource] += amount;
        }

        this._pushEvent({
          type: 'build',
          turn: this.turnNumber,
          player: playerId,
          building
        });

        return { type: 'build', player: playerId, building };
      }
    }
    return null;
  }

  /**
   * Generate bank trade event
   */
  generateBankTrade() {
    const players = this._shuffle([...Array(this.playerCount).keys()].map(i => i + 1));

    for (const playerId of players) {
      const hand = this.hands[playerId];

      // Find a resource we have 4+ of
      const canTrade = RESOURCES.filter(r => hand[r] >= 4);
      if (canTrade.length === 0) continue;

      const giveResource = canTrade[Math.floor(Math.random() * canTrade.length)];

      // Find a resource to receive
      const canReceive = RESOURCES.filter(r => r !== giveResource && this.bank[r] > 0);
      if (canReceive.length === 0) continue;

      const receiveResource = canReceive[Math.floor(Math.random() * canReceive.length)];

      // Execute trade
      const give = { [giveResource]: 4 };
      const receive = { [receiveResource]: 1 };

      this.hands[playerId][giveResource] -= 4;
      this.hands[playerId][receiveResource] += 1;
      this.bank[giveResource] += 4;
      this.bank[receiveResource] -= 1;

      this._pushEvent({
        type: 'bankTrade',
        turn: this.turnNumber,
        player: playerId,
        give,
        receive
      });

      return { type: 'bankTrade', player: playerId, give, receive };
    }
    return null;
  }

  /**
   * Generate player trade event
   */
  generatePlayerTrade() {
    if (this.playerCount < 2) return null;

    const players = this._shuffle([...Array(this.playerCount).keys()].map(i => i + 1));
    const player1 = players[0];
    const player2 = players[1];

    const hand1 = this.hands[player1];
    const hand2 = this.hands[player2];

    // Find what player1 can give
    const canGive1 = RESOURCES.filter(r => hand1[r] >= 1);
    const canGive2 = RESOURCES.filter(r => hand2[r] >= 1);

    if (canGive1.length === 0 || canGive2.length === 0) return null;

    const give1Resource = canGive1[Math.floor(Math.random() * canGive1.length)];
    const give2Resource = canGive2[Math.floor(Math.random() * canGive2.length)];

    const give1 = { [give1Resource]: 1 };
    const give2 = { [give2Resource]: 1 };

    // Execute trade
    this.hands[player1][give1Resource] -= 1;
    this.hands[player1][give2Resource] += 1;
    this.hands[player2][give2Resource] -= 1;
    this.hands[player2][give1Resource] += 1;

    this._pushEvent({
      type: 'playerTrade',
      turn: this.turnNumber,
      player1,
      give1,
      player2,
      give2
    });

    return { type: 'playerTrade', player1, give1, player2, give2 };
  }

  /**
   * Generate steal event
   */
  generateSteal() {
    const players = [...Array(this.playerCount).keys()].map(i => i + 1);
    const playersWithCards = players.filter(p => this.getCardCount(p) > 0);

    if (playersWithCards.length < 2) return null;

    const thief = players[Math.floor(Math.random() * players.length)];
    const possibleVictims = playersWithCards.filter(p => p !== thief);

    if (possibleVictims.length === 0) return null;

    const victim = possibleVictims[Math.floor(Math.random() * possibleVictims.length)];
    const stolenResource = this.pickRandomResource(victim);

    if (!stolenResource) return null;

    // Execute steal
    this.hands[victim][stolenResource] -= 1;
    this.hands[thief][stolenResource] += 1;

    // Record ground truth (this is hidden from tracker)
    this.stealHistory.push({
      turn: this.turnNumber,
      thief,
      victim,
      resource: stolenResource
    });

    this._pushEvent({
      type: 'steal',
      turn: this.turnNumber,
      thief,
      victim
      // Note: resource is NOT included - this is the hidden info!
    });

    return { type: 'steal', thief, victim, _actualResource: stolenResource };
  }

  /**
   * Generate discard event (as if 7 was rolled)
   */
  generateDiscard() {
    const players = [...Array(this.playerCount).keys()].map(i => i + 1);
    const playersToDiscard = players.filter(p => this.getCardCount(p) > 7);

    if (playersToDiscard.length === 0) return null;

    const results = [];

    for (const playerId of playersToDiscard) {
      const hand = this.hands[playerId];
      const total = this.getCardCount(playerId);
      const toDiscard = Math.floor(total / 2);

      const discarded = {};
      let remaining = toDiscard;

      // Randomly discard
      while (remaining > 0) {
        const resource = this.pickRandomResource(playerId);
        if (!resource) break;

        discarded[resource] = (discarded[resource] || 0) + 1;
        this.hands[playerId][resource] -= 1;
        this.bank[resource] += 1;
        remaining--;
      }

      this._pushEvent({
        type: 'discard',
        turn: this.turnNumber,
        player: playerId,
        discarded
      });

      results.push({ type: 'discard', player: playerId, discarded });
    }

    return results.length > 0 ? results : null;
  }

  /**
   * Generate monopoly event
   */
  generateMonopoly() {
    const playerId = Math.floor(Math.random() * this.playerCount) + 1;
    const resource = RESOURCES[Math.floor(Math.random() * RESOURCES.length)];

    const takenFrom = {};
    for (let i = 1; i <= this.playerCount; i++) {
      if (i === playerId) continue;
      const amount = this.hands[i][resource];
      if (amount > 0) {
        takenFrom[i] = amount;
        this.hands[playerId][resource] += amount;
        this.hands[i][resource] = 0;
      }
    }

    if (Object.keys(takenFrom).length === 0) return null;

    this._pushEvent({
      type: 'monopoly',
      turn: this.turnNumber,
      player: playerId,
      resource,
      takenFrom
    });

    return { type: 'monopoly', player: playerId, resource, takenFrom };
  }

  /**
   * Generate year of plenty event
   */
  generateYearOfPlenty() {
    const playerId = Math.floor(Math.random() * this.playerCount) + 1;
    const available = RESOURCES.filter(r => this.bank[r] > 0);

    if (available.length === 0) return null;

    const resources = {};
    for (let i = 0; i < 2; i++) {
      if (available.length === 0) break;
      const resource = available[Math.floor(Math.random() * available.length)];
      if (this.bank[resource] > 0) {
        resources[resource] = (resources[resource] || 0) + 1;
        this.hands[playerId][resource] += 1;
        this.bank[resource] -= 1;
      }
    }

    if (Object.keys(resources).length === 0) return null;

    this._pushEvent({
      type: 'yearOfPlenty',
      turn: this.turnNumber,
      player: playerId,
      resources
    });

    return { type: 'yearOfPlenty', player: playerId, resources };
  }

  /**
   * Generate a random event
   */
  generateRandomEvent() {
    const weights = this.options;
    const totalWeight =
      weights.productionWeight +
      weights.buildWeight +
      weights.tradeWeight +
      weights.stealWeight +
      weights.discardWeight;

    let roll = Math.random() * totalWeight;

    roll -= weights.productionWeight;
    if (roll <= 0) return this.generateProduction();

    roll -= weights.buildWeight;
    if (roll <= 0) return this.generateBuild();

    roll -= weights.tradeWeight;
    if (roll <= 0) {
      return Math.random() < 0.5 ? this.generateBankTrade() : this.generatePlayerTrade();
    }

    roll -= weights.stealWeight;
    if (roll <= 0) return this.generateSteal();

    roll -= weights.discardWeight;
    if (roll <= 0) return this.generateDiscard();

    return this.generateProduction();
  }

  /**
   * Get current card counts for all players
   */
  getAllCardCounts() {
    const counts = {};
    for (let i = 1; i <= this.playerCount; i++) {
      counts[i] = this.getCardCount(i);
    }
    return counts;
  }

  /**
   * Push event with current card counts snapshot
   */
  _pushEvent(eventData) {
    // Capture card counts at time of event (like in real game where counts are always visible)
    eventData.cardCounts = this.getAllCardCounts();
    this.events.push(eventData);
  }

  /**
   * Simulate a full game
   */
  simulate(numTurns = 50) {
    for (let t = 0; t < numTurns; t++) {
      this.turnNumber = t;

      // Always do production at start of turn
      this.generateProduction();

      // Maybe do 1-2 other events
      const numEvents = Math.floor(Math.random() * 3);
      for (let e = 0; e < numEvents; e++) {
        this.generateRandomEvent();
      }
    }

    return {
      events: this.events,
      groundTruth: this.getGroundTruth(),
      stealHistory: this.stealHistory
    };
  }

  /**
   * Get current ground truth state
   */
  getGroundTruth() {
    return {
      hands: JSON.parse(JSON.stringify(this.hands)),
      bank: JSON.parse(JSON.stringify(this.bank)),
      cardCounts: Object.fromEntries(
        Object.entries(this.hands).map(([p, h]) => [p, Object.values(h).reduce((a, b) => a + b, 0)])
      )
    };
  }

  /**
   * Shuffle array in place
   */
  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

/**
 * Run simulation and feed events to tracker, then compare
 */
function runSimulationTest(options = {}) {
  const { CardTracker } = require('./card-tracker');

  const playerCount = options.playerCount || 4;
  const numTurns = options.numTurns || 30;
  const verbose = options.verbose || false;

  // Run simulation
  const sim = new GameSimulator(playerCount);
  const { events, groundTruth, stealHistory } = sim.simulate(numTurns);

  // Create tracker and feed events
  const tracker = new CardTracker(playerCount);

  for (const event of events) {
    switch (event.type) {
      case 'production':
        tracker.processProduction(event.data);
        break;
      case 'build':
        tracker.processBuild(event.player, event.building);
        break;
      case 'bankTrade':
        tracker.processBankTrade(event.player, event.give, event.receive);
        break;
      case 'playerTrade':
        tracker.processPlayerTrade(event.player1, event.give1, event.player2, event.give2);
        break;
      case 'steal':
        tracker.processSteal(event.thief, event.victim);
        break;
      case 'discard':
        tracker.processDiscard(event.player, event.discarded);
        break;
      case 'monopoly':
        tracker.processMonopoly(event.player, event.resource, event.takenFrom);
        break;
      case 'yearOfPlenty':
        tracker.processYearOfPlenty(event.player, event.resources);
        break;
    }

    // Apply known card counts - constrains possible worlds
    if (event.cardCounts) {
      // Convert string keys to integers
      const counts = {};
      for (const [pid, count] of Object.entries(event.cardCounts)) {
        counts[parseInt(pid)] = count;
      }
      tracker.setAllCardCounts(counts);
    }

    tracker.nextTurn();
  }

  // Compare results
  const results = {
    events: events.length,
    steals: stealHistory.length,
    worlds: tracker.worlds.length,
    players: {}
  };

  for (let p = 1; p <= playerCount; p++) {
    const marginals = tracker.getMarginals(p);
    const actual = groundTruth.hands[p];

    const playerResult = {
      actual,
      estimated: {},
      errors: {},
      withinRange: true
    };

    for (const resource of RESOURCES) {
      const est = marginals[resource];
      playerResult.estimated[resource] = {
        expected: est.expected.toFixed(2),
        range: `${est.min}-${est.max}`
      };
      playerResult.errors[resource] = Math.abs(actual[resource] - est.expected);

      // Check if actual is within estimated range
      if (actual[resource] < est.min || actual[resource] > est.max) {
        playerResult.withinRange = false;
      }
    }

    playerResult.confidence = tracker.getConfidence(p);
    results.players[p] = playerResult;
  }

  // Overall accuracy metrics
  let totalError = 0;
  let totalCards = 0;
  let allWithinRange = true;

  for (let p = 1; p <= playerCount; p++) {
    const pr = results.players[p];
    for (const resource of RESOURCES) {
      totalError += pr.errors[resource];
      totalCards += pr.actual[resource];
    }
    if (!pr.withinRange) allWithinRange = false;
  }

  results.totalError = totalError;
  results.meanAbsoluteError = totalError / (playerCount * RESOURCES.length);
  results.allWithinRange = allWithinRange;

  if (verbose) {
    console.log('\n=== Simulation Results ===');
    console.log(`Events: ${results.events}, Steals: ${results.steals}, Worlds: ${results.worlds}`);
    console.log(`Mean Absolute Error: ${results.meanAbsoluteError.toFixed(3)}`);
    console.log(`All within range: ${results.allWithinRange}`);

    for (let p = 1; p <= playerCount; p++) {
      const pr = results.players[p];
      console.log(`\nPlayer ${p} (confidence: ${(pr.confidence * 100).toFixed(1)}%):`);
      console.log(`  Actual:    ${RESOURCES.map(r => `${r[0]}:${pr.actual[r]}`).join(' ')}`);
      console.log(`  Expected:  ${RESOURCES.map(r => `${r[0]}:${pr.estimated[r].expected}`).join(' ')}`);
      console.log(`  Range:     ${RESOURCES.map(r => `${r[0]}:${pr.estimated[r].range}`).join(' ')}`);
      console.log(`  In range:  ${pr.withinRange}`);
    }
  }

  return results;
}

/**
 * Run many simulations and aggregate statistics
 */
function runManySimulations(count = 100, options = {}) {
  const results = [];
  let successCount = 0;

  for (let i = 0; i < count; i++) {
    const result = runSimulationTest({ ...options, verbose: false });
    results.push(result);
    if (result.allWithinRange) successCount++;
  }

  // Aggregate stats
  const maeValues = results.map(r => r.meanAbsoluteError);
  const avgMAE = maeValues.reduce((a, b) => a + b, 0) / count;
  const maxMAE = Math.max(...maeValues);
  const successRate = successCount / count;

  const avgWorlds = results.reduce((sum, r) => sum + r.worlds, 0) / count;

  console.log('\n=== Aggregate Results ===');
  console.log(`Simulations: ${count}`);
  console.log(`Success rate (actual in range): ${(successRate * 100).toFixed(1)}%`);
  console.log(`Average MAE: ${avgMAE.toFixed(3)}`);
  console.log(`Max MAE: ${maxMAE.toFixed(3)}`);
  console.log(`Average worlds: ${avgWorlds.toFixed(1)}`);

  return {
    count,
    successRate,
    avgMAE,
    maxMAE,
    avgWorlds
  };
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GameSimulator, runSimulationTest, runManySimulations };
}
