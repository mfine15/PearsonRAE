/**
 * Card Tracker - Probabilistic inference for opponent hands in Catan
 *
 * Uses constraint satisfaction with forward DP to track possible game states.
 * Maintains multiple "worlds" (possible hand assignments) weighted by probability.
 */

'use strict';

// Base resources
const RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
const RESOURCE_INDEX = { wood: 0, brick: 1, sheep: 2, wheat: 3, ore: 4 };
const TOTAL_PER_RESOURCE = 19; // Standard Catan

// C&K Commodities
const COMMODITIES = ['cloth', 'coin', 'paper'];
const COMMODITY_INDEX = { cloth: 5, coin: 6, paper: 7 };
const TOTAL_PER_COMMODITY = 12; // C&K has fewer commodities

// Combined for iteration
const ALL_CARD_TYPES = [...RESOURCES, ...COMMODITIES];
const ALL_CARD_INDEX = { ...RESOURCE_INDEX, ...COMMODITY_INDEX };

// Resource to commodity mapping (for city production)
const RESOURCE_TO_COMMODITY = {
  sheep: 'cloth',
  ore: 'coin',
  wood: 'paper'
};

const BUILDING_COSTS = {
  road: { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 0 },
  city: { wood: 0, brick: 0, sheep: 0, wheat: 2, ore: 3 },
  devCard: { wood: 0, brick: 0, sheep: 1, wheat: 1, ore: 1 },
  // C&K specific
  cityWall: { brick: 2 },
  knight: { sheep: 1, ore: 1 },  // Activate knight
  strongKnight: { sheep: 1, ore: 1 },  // Upgrade to strong
  mightyKnight: { sheep: 1, ore: 1 }   // Upgrade to mighty
};

/**
 * Immutable hand state for a single player
 * Supports both base game (5 resources) and C&K (5 resources + 3 commodities)
 */
class Hand {
  constructor(cards = null, isCK = false) {
    // cards is an array [wood, brick, sheep, wheat, ore, cloth?, coin?, paper?]
    this.isCK = isCK;
    const size = isCK ? 8 : 5;
    this.cards = cards ? [...cards] : new Array(size).fill(0);
    // Ensure correct size
    while (this.cards.length < size) this.cards.push(0);
  }

  get(cardType) {
    const idx = ALL_CARD_INDEX[cardType];
    if (idx === undefined || idx >= this.cards.length) return 0;
    return this.cards[idx];
  }

  total() {
    return this.cards.reduce((a, b) => a + b, 0);
  }

  totalResources() {
    return this.cards.slice(0, 5).reduce((a, b) => a + b, 0);
  }

  totalCommodities() {
    if (!this.isCK) return 0;
    return this.cards.slice(5).reduce((a, b) => a + b, 0);
  }

  clone() {
    return new Hand(this.cards, this.isCK);
  }

  add(cardType, amount = 1) {
    const idx = ALL_CARD_INDEX[cardType];
    if (idx === undefined) return this;
    const newHand = this.clone();
    if (idx < newHand.cards.length) {
      newHand.cards[idx] += amount;
    }
    return newHand;
  }

  subtract(cardType, amount = 1) {
    return this.add(cardType, -amount);
  }

  isValid() {
    return this.cards.every(c => c >= 0);
  }

  equals(other) {
    return this.cards.every((c, i) => c === (other.cards[i] || 0));
  }

  hash() {
    return this.cards.join(',');
  }

  toObject() {
    const obj = {};
    RESOURCES.forEach((r, i) => obj[r] = this.cards[i]);
    if (this.isCK) {
      COMMODITIES.forEach((c, i) => obj[c] = this.cards[5 + i]);
    }
    return obj;
  }

  // Get list of card types this hand contains (for steal possibilities)
  getStealableTypes() {
    const types = [];
    const allTypes = this.isCK ? ALL_CARD_TYPES : RESOURCES;
    for (const cardType of allTypes) {
      if (this.get(cardType) > 0) {
        types.push(cardType);
      }
    }
    return types;
  }

  static fromObject(obj, isCK = false) {
    const cards = RESOURCES.map(r => obj[r] || 0);
    if (isCK) {
      COMMODITIES.forEach(c => cards.push(obj[c] || 0));
    }
    return new Hand(cards, isCK);
  }
}

/**
 * A possible game state (one "world")
 * Contains hands for all players and the probability of this world
 */
class GameState {
  constructor(playerCount, hands = null, probability = 1.0, isCK = false) {
    this.playerCount = playerCount;
    this.isCK = isCK;
    // hands is Map<playerId, Hand>
    this.hands = hands || new Map();
    this.probability = probability;

    // Initialize empty hands for all players
    if (!hands) {
      for (let i = 1; i <= playerCount; i++) {
        this.hands.set(i, new Hand(null, isCK));
      }
    }
  }

  clone() {
    const newHands = new Map();
    for (const [player, hand] of this.hands) {
      newHands.set(player, hand.clone());
    }
    return new GameState(this.playerCount, newHands, this.probability, this.isCK);
  }

  getHand(player) {
    return this.hands.get(player);
  }

  setHand(player, hand) {
    const newState = this.clone();
    newState.hands.set(player, hand);
    return newState;
  }

  isValid(constraints = {}) {
    // Check all hands are non-negative
    for (const [player, hand] of this.hands) {
      if (!hand.isValid()) return false;

      // Check against known card counts
      if (constraints.cardCounts && constraints.cardCounts[player] !== undefined) {
        if (hand.total() !== constraints.cardCounts[player]) return false;
      }
    }

    // Check bank constraint
    if (constraints.bank) {
      for (const resource of RESOURCES) {
        const totalHeld = this.getTotalResource(resource);
        const inBank = constraints.bank[resource];
        if (totalHeld + inBank !== TOTAL_PER_RESOURCE) return false;
      }
    }

    return true;
  }

  getTotalCardType(cardType) {
    let total = 0;
    for (const [_, hand] of this.hands) {
      total += hand.get(cardType);
    }
    return total;
  }

  // Alias for backwards compatibility
  getTotalResource(resource) {
    return this.getTotalCardType(resource);
  }

  hash() {
    const parts = [];
    for (let i = 1; i <= this.playerCount; i++) {
      parts.push(`${i}:${this.hands.get(i).hash()}`);
    }
    return parts.join('|');
  }

  equals(other) {
    for (let i = 1; i <= this.playerCount; i++) {
      if (!this.hands.get(i).equals(other.hands.get(i))) return false;
    }
    return true;
  }
}

/**
 * Main card tracker using forward DP with constraint pruning
 */
class CardTracker {
  constructor(playerCount, options = {}) {
    this.playerCount = playerCount;
    this.maxWorlds = options.maxWorlds || 1000;
    this.pruneThreshold = options.pruneThreshold || 0.0001;
    this.isCK = options.citiesAndKnights || false;

    // Current possible worlds
    this.worlds = [new GameState(playerCount, null, 1.0, this.isCK)];

    // Known constraints
    this.bank = null; // null if not visible, otherwise {resource: count}
    this.cardCounts = {}; // playerId -> known card count

    // Event log for debugging
    this.eventLog = [];
    this.turnNumber = 0;
  }

  /**
   * Process a production event (dice roll)
   * This is deterministic - all worlds update the same way
   */
  processProduction(productions) {
    // productions is {playerId: {resource: amount}}
    this.eventLog.push({ type: 'production', turn: this.turnNumber, data: productions });

    for (const world of this.worlds) {
      for (const [playerId, resources] of Object.entries(productions)) {
        const pid = parseInt(playerId);
        let hand = world.getHand(pid);
        for (const [resource, amount] of Object.entries(resources)) {
          hand = hand.add(resource, amount);
        }
        world.hands.set(pid, hand);
      }
    }

    // Update bank if visible
    if (this.bank) {
      for (const [playerId, resources] of Object.entries(productions)) {
        for (const [resource, amount] of Object.entries(resources)) {
          this.bank[resource] -= amount;
        }
      }
    }

    this._updateCardCounts(productions);
  }

  /**
   * Process a build event
   * Deterministic, but also serves as proof-of-existence constraint
   */
  processBuild(playerId, buildingType) {
    const cost = BUILDING_COSTS[buildingType];
    if (!cost) throw new Error(`Unknown building type: ${buildingType}`);

    this.eventLog.push({ type: 'build', turn: this.turnNumber, player: playerId, building: buildingType });

    // Filter worlds where this build is possible
    const validWorlds = [];
    for (const world of this.worlds) {
      const hand = world.getHand(playerId);
      let canBuild = true;

      for (const [resource, amount] of Object.entries(cost)) {
        if (hand.get(resource) < amount) {
          canBuild = false;
          break;
        }
      }

      if (canBuild) {
        // Subtract cost
        let newHand = hand;
        for (const [resource, amount] of Object.entries(cost)) {
          newHand = newHand.subtract(resource, amount);
        }
        world.hands.set(playerId, newHand);
        validWorlds.push(world);
      }
    }

    if (validWorlds.length === 0) {
      console.warn(`No valid worlds after build! Player ${playerId} built ${buildingType}`);
      // Keep at least one world, adjust as needed
      this.worlds = [this.worlds[0]];
    } else {
      this.worlds = validWorlds;
      this._renormalize();
    }

    // Update bank if visible
    if (this.bank) {
      for (const [resource, amount] of Object.entries(cost)) {
        this.bank[resource] += amount;
      }
    }

    this.cardCounts[playerId] = (this.cardCounts[playerId] || 0) - Object.values(cost).reduce((a, b) => a + b, 0);
  }

  /**
   * Process a trade with the bank or port
   * Deterministic
   */
  processBankTrade(playerId, give, receive) {
    // give and receive are {resource: amount}
    this.eventLog.push({ type: 'bankTrade', turn: this.turnNumber, player: playerId, give, receive });

    const validWorlds = [];
    for (const world of this.worlds) {
      let hand = world.getHand(playerId);
      let canTrade = true;

      // Check and subtract given resources
      for (const [resource, amount] of Object.entries(give)) {
        if (hand.get(resource) < amount) {
          canTrade = false;
          break;
        }
        hand = hand.subtract(resource, amount);
      }

      if (canTrade) {
        // Add received resources
        for (const [resource, amount] of Object.entries(receive)) {
          hand = hand.add(resource, amount);
        }
        world.hands.set(playerId, hand);
        validWorlds.push(world);
      }
    }

    this.worlds = validWorlds.length > 0 ? validWorlds : [this.worlds[0]];
    this._renormalize();

    // Update bank
    if (this.bank) {
      for (const [resource, amount] of Object.entries(give)) {
        this.bank[resource] += amount;
      }
      for (const [resource, amount] of Object.entries(receive)) {
        this.bank[resource] -= amount;
      }
    }
  }

  /**
   * Process a player-to-player trade
   * Deterministic but validates both players have cards
   */
  processPlayerTrade(player1, give1, player2, give2) {
    // player1 gives give1 to player2, player2 gives give2 to player1
    this.eventLog.push({ type: 'playerTrade', turn: this.turnNumber, player1, give1, player2, give2 });

    const validWorlds = [];
    for (const world of this.worlds) {
      let hand1 = world.getHand(player1);
      let hand2 = world.getHand(player2);
      let canTrade = true;

      // Check player1 can give
      for (const [resource, amount] of Object.entries(give1)) {
        if (hand1.get(resource) < amount) {
          canTrade = false;
          break;
        }
      }

      // Check player2 can give
      if (canTrade) {
        for (const [resource, amount] of Object.entries(give2)) {
          if (hand2.get(resource) < amount) {
            canTrade = false;
            break;
          }
        }
      }

      if (canTrade) {
        // Execute trade
        for (const [resource, amount] of Object.entries(give1)) {
          hand1 = hand1.subtract(resource, amount);
          hand2 = hand2.add(resource, amount);
        }
        for (const [resource, amount] of Object.entries(give2)) {
          hand2 = hand2.subtract(resource, amount);
          hand1 = hand1.add(resource, amount);
        }
        world.hands.set(player1, hand1);
        world.hands.set(player2, hand2);
        validWorlds.push(world);
      }
    }

    this.worlds = validWorlds.length > 0 ? validWorlds : [this.worlds[0]];
    this._renormalize();
  }

  /**
   * Process a steal (robber or knight)
   * This is the key probabilistic event - branches worlds
   * In C&K, steals can take resources OR commodities
   */
  processSteal(thief, victim) {
    this.eventLog.push({ type: 'steal', turn: this.turnNumber, thief, victim });

    const newWorlds = [];
    const cardTypes = this.isCK ? ALL_CARD_TYPES : RESOURCES;

    for (const world of this.worlds) {
      const victimHand = world.getHand(victim);
      const totalCards = victimHand.total();

      if (totalCards === 0) {
        // No cards to steal - world continues unchanged
        newWorlds.push(world);
        continue;
      }

      // Branch into possible steal outcomes
      for (const cardType of cardTypes) {
        const count = victimHand.get(cardType);
        if (count === 0) continue;

        // Probability of stealing this card type
        const stealProb = count / totalCards;

        // Create new world with this steal
        const newWorld = world.clone();
        newWorld.probability = world.probability * stealProb;

        let newVictimHand = victimHand.subtract(cardType, 1);
        let newThiefHand = world.getHand(thief).add(cardType, 1);

        newWorld.hands.set(victim, newVictimHand);
        newWorld.hands.set(thief, newThiefHand);

        newWorlds.push(newWorld);
      }
    }

    this.worlds = newWorlds;
    this._mergeAndPrune();
  }

  /**
   * Process C&K Spy card - player looks at victim's hand and steals 1 card
   * If we know what was stolen, it's deterministic
   */
  processSpy(thief, victim, stolenCard = null) {
    if (stolenCard) {
      // We know what was stolen (deterministic)
      this.eventLog.push({ type: 'spy', turn: this.turnNumber, thief, victim, stolenCard });

      const validWorlds = [];
      for (const world of this.worlds) {
        const victimHand = world.getHand(victim);
        if (victimHand.get(stolenCard) < 1) continue;

        let newVictimHand = victimHand.subtract(stolenCard, 1);
        let newThiefHand = world.getHand(thief).add(stolenCard, 1);

        world.hands.set(victim, newVictimHand);
        world.hands.set(thief, newThiefHand);
        validWorlds.push(world);
      }

      this.worlds = validWorlds.length > 0 ? validWorlds : [this.worlds[0]];
      this._renormalize();
    } else {
      // Unknown what was stolen - same as regular steal
      this.processSteal(thief, victim);
    }
  }

  /**
   * Process C&K Master Merchant - steal 2 resources from player with more VP
   * We only see that 2 cards were stolen, not which ones
   */
  processMasterMerchant(thief, victim) {
    this.eventLog.push({ type: 'masterMerchant', turn: this.turnNumber, thief, victim });

    // Two sequential steals
    this.processSteal(thief, victim);
    this.processSteal(thief, victim);
  }

  /**
   * Process C&K Wedding - each player with more VP gives 2 resources
   * The victim chooses what to give, so if we see the cards, it's deterministic
   */
  processWedding(receiver, gifts) {
    // gifts is {playerId: {cardType: amount, ...}, ...}
    this.eventLog.push({ type: 'wedding', turn: this.turnNumber, receiver, gifts });

    const validWorlds = [];
    for (const world of this.worlds) {
      let canProcess = true;
      let receiverHand = world.getHand(receiver);

      for (const [giverId, giftCards] of Object.entries(gifts)) {
        const gid = parseInt(giverId);
        let giverHand = world.getHand(gid);

        for (const [cardType, amount] of Object.entries(giftCards)) {
          if (giverHand.get(cardType) < amount) {
            canProcess = false;
            break;
          }
          giverHand = giverHand.subtract(cardType, amount);
          receiverHand = receiverHand.add(cardType, amount);
        }
        if (!canProcess) break;
        world.hands.set(gid, giverHand);
      }

      if (canProcess) {
        world.hands.set(receiver, receiverHand);
        validWorlds.push(world);
      }
    }

    this.worlds = validWorlds.length > 0 ? validWorlds : [this.worlds[0]];
    this._renormalize();
  }

  /**
   * Process a discard event (7 was rolled)
   * If we know what was discarded, it's deterministic
   * If unknown, it branches (but usually we know from log)
   */
  processDiscard(playerId, discarded) {
    // discarded is {resource: amount}
    this.eventLog.push({ type: 'discard', turn: this.turnNumber, player: playerId, discarded });

    const validWorlds = [];
    for (const world of this.worlds) {
      let hand = world.getHand(playerId);
      let canDiscard = true;

      for (const [resource, amount] of Object.entries(discarded)) {
        if (hand.get(resource) < amount) {
          canDiscard = false;
          break;
        }
        hand = hand.subtract(resource, amount);
      }

      if (canDiscard) {
        world.hands.set(playerId, hand);
        validWorlds.push(world);
      }
    }

    this.worlds = validWorlds.length > 0 ? validWorlds : [this.worlds[0]];
    this._renormalize();

    // Update bank
    if (this.bank) {
      for (const [resource, amount] of Object.entries(discarded)) {
        this.bank[resource] += amount;
      }
    }
  }

  /**
   * Process monopoly card
   * We see exactly what was taken from each player
   */
  processMonopoly(playerId, resource, takenFrom) {
    // takenFrom is {playerId: amount}
    this.eventLog.push({ type: 'monopoly', turn: this.turnNumber, player: playerId, resource, takenFrom });

    const validWorlds = [];
    for (const world of this.worlds) {
      let canProcess = true;
      let thiefHand = world.getHand(playerId);

      for (const [victimId, amount] of Object.entries(takenFrom)) {
        const vid = parseInt(victimId);
        const victimHand = world.getHand(vid);

        if (victimHand.get(resource) < amount) {
          canProcess = false;
          break;
        }

        // Take from victim
        world.hands.set(vid, victimHand.subtract(resource, amount));
        thiefHand = thiefHand.add(resource, amount);
      }

      if (canProcess) {
        world.hands.set(playerId, thiefHand);
        validWorlds.push(world);
      }
    }

    this.worlds = validWorlds.length > 0 ? validWorlds : [this.worlds[0]];
    this._renormalize();
  }

  /**
   * Process Year of Plenty card
   * Deterministic - player takes 2 resources from bank
   */
  processYearOfPlenty(playerId, resources) {
    // resources is {resource: amount}, total should be 2
    this.eventLog.push({ type: 'yearOfPlenty', turn: this.turnNumber, player: playerId, resources });

    for (const world of this.worlds) {
      let hand = world.getHand(playerId);
      for (const [resource, amount] of Object.entries(resources)) {
        hand = hand.add(resource, amount);
      }
      world.hands.set(playerId, hand);
    }

    // Update bank
    if (this.bank) {
      for (const [resource, amount] of Object.entries(resources)) {
        this.bank[resource] -= amount;
      }
    }
  }

  /**
   * Update known card counts from production
   */
  _updateCardCounts(productions) {
    for (const [playerId, resources] of Object.entries(productions)) {
      const pid = parseInt(playerId);
      const added = Object.values(resources).reduce((a, b) => a + b, 0);
      this.cardCounts[pid] = (this.cardCounts[pid] || 0) + added;
    }
  }

  /**
   * Set observed card count for a player
   */
  setCardCount(playerId, count) {
    this.cardCounts[playerId] = count;
    this._applyConstraints();
  }

  /**
   * Set bank totals (if visible in game settings)
   */
  setBank(bank) {
    this.bank = { ...bank };
    this._applyConstraints();
  }

  /**
   * Apply constraints to filter invalid worlds
   */
  _applyConstraints() {
    const constraints = {
      cardCounts: this.cardCounts,
      bank: this.bank
    };

    this.worlds = this.worlds.filter(w => w.isValid(constraints));

    if (this.worlds.length === 0) {
      console.warn('All worlds invalidated by constraints! Resetting...');
      this.worlds = [new GameState(this.playerCount)];
    }

    this._renormalize();
  }

  /**
   * Renormalize probabilities to sum to 1
   */
  _renormalize() {
    const total = this.worlds.reduce((sum, w) => sum + w.probability, 0);
    if (total > 0) {
      for (const world of this.worlds) {
        world.probability /= total;
      }
    }
  }

  /**
   * Merge identical worlds and prune low-probability ones
   */
  _mergeAndPrune() {
    // Merge identical worlds
    const worldMap = new Map();
    for (const world of this.worlds) {
      const hash = world.hash();
      if (worldMap.has(hash)) {
        worldMap.get(hash).probability += world.probability;
      } else {
        worldMap.set(hash, world);
      }
    }

    this.worlds = Array.from(worldMap.values());
    this._renormalize();

    // Prune low probability worlds
    this.worlds = this.worlds.filter(w => w.probability >= this.pruneThreshold);

    // If too many worlds, keep top N by probability
    if (this.worlds.length > this.maxWorlds) {
      this.worlds.sort((a, b) => b.probability - a.probability);
      this.worlds = this.worlds.slice(0, this.maxWorlds);
    }

    this._renormalize();
  }

  /**
   * Get marginal probability distribution for a player's hand
   */
  getMarginals(playerId) {
    const marginals = {};
    const cardTypes = this.isCK ? ALL_CARD_TYPES : RESOURCES;

    for (const cardType of cardTypes) {
      const distribution = new Map(); // count -> probability
      let expectedValue = 0;
      let min = Infinity;
      let max = -Infinity;

      for (const world of this.worlds) {
        const count = world.getHand(playerId).get(cardType);
        distribution.set(count, (distribution.get(count) || 0) + world.probability);
        expectedValue += count * world.probability;
        min = Math.min(min, count);
        max = Math.max(max, count);
      }

      marginals[cardType] = {
        expected: expectedValue,
        min: min === Infinity ? 0 : min,
        max: max === -Infinity ? 0 : max,
        distribution: Object.fromEntries(distribution)
      };
    }

    // Also compute total cards
    let expectedTotal = 0;
    let minTotal = Infinity;
    let maxTotal = -Infinity;

    for (const world of this.worlds) {
      const total = world.getHand(playerId).total();
      expectedTotal += total * world.probability;
      minTotal = Math.min(minTotal, total);
      maxTotal = Math.max(maxTotal, total);
    }

    marginals.total = {
      expected: expectedTotal,
      min: minTotal === Infinity ? 0 : minTotal,
      max: maxTotal === -Infinity ? 0 : maxTotal
    };

    // For C&K, also compute resource and commodity subtotals
    if (this.isCK) {
      let expectedResources = 0, expectedCommodities = 0;
      for (const world of this.worlds) {
        const hand = world.getHand(playerId);
        expectedResources += hand.totalResources() * world.probability;
        expectedCommodities += hand.totalCommodities() * world.probability;
      }
      marginals.totalResources = { expected: expectedResources };
      marginals.totalCommodities = { expected: expectedCommodities };
    }

    return marginals;
  }

  /**
   * Get the most likely hand for a player
   */
  getMostLikelyHand(playerId) {
    let bestWorld = this.worlds[0];
    for (const world of this.worlds) {
      if (world.probability > bestWorld.probability) {
        bestWorld = world;
      }
    }
    return bestWorld.getHand(playerId).toObject();
  }

  /**
   * Get confidence score (0-1) based on world distribution
   * High confidence = most probability mass in few worlds
   */
  getConfidence(playerId) {
    // Compute entropy of hand distributions
    let entropy = 0;
    const cardTypes = this.isCK ? ALL_CARD_TYPES : RESOURCES;

    for (const cardType of cardTypes) {
      const distribution = new Map();
      for (const world of this.worlds) {
        const count = world.getHand(playerId).get(cardType);
        distribution.set(count, (distribution.get(count) || 0) + world.probability);
      }

      for (const prob of distribution.values()) {
        if (prob > 0) {
          entropy -= prob * Math.log2(prob);
        }
      }
    }

    // Convert entropy to confidence (lower entropy = higher confidence)
    // Max entropy would be if each card type uniformly distributed across many values
    const maxEntropy = cardTypes.length * Math.log2(10); // Assume max 10 of each type
    const confidence = Math.max(0, 1 - entropy / maxEntropy);

    return confidence;
  }

  /**
   * Advance turn counter
   */
  nextTurn() {
    this.turnNumber++;
  }

  /**
   * Get debug info
   */
  getDebugInfo() {
    return {
      turnNumber: this.turnNumber,
      worldCount: this.worlds.length,
      bank: this.bank,
      cardCounts: this.cardCounts,
      topWorlds: this.worlds.slice(0, 5).map(w => ({
        probability: w.probability,
        hands: Object.fromEntries(
          Array.from(w.hands.entries()).map(([p, h]) => [p, h.toObject()])
        )
      }))
    };
  }
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CardTracker,
    GameState,
    Hand,
    RESOURCES,
    COMMODITIES,
    ALL_CARD_TYPES,
    BUILDING_COSTS,
    TOTAL_PER_RESOURCE,
    TOTAL_PER_COMMODITY,
    RESOURCE_TO_COMMODITY
  };
}
