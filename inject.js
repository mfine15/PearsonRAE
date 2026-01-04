(function() {
  'use strict';

  if (window._rollsTrackerLoaded) return;
  window._rollsTrackerLoaded = true;

  let gameStore = null;
  let overlay = null;
  let unsubscribe = null;
  let debugLog = [];
  let currentView = 'main';
  let isCollapsed = false;

  // Stateful tracking - snapshot card counts at each roll
  let rollHistory = []; // Array of { turn, diceSum, player, cardCounts: {1: n, 2: n, ...} }
  let lastKnownRollCount = 0;

  const RESOURCE_TYPES = {
    0: { name: 'Desert', color: '#d4a574', emoji: '🏜️' },
    1: { name: 'Wood', color: '#2d5a27', emoji: '🪵' },
    2: { name: 'Brick', color: '#b84c2e', emoji: '🧱' },
    3: { name: 'Sheep', color: '#90c960', emoji: '🐑' },
    4: { name: 'Wheat', color: '#f4d03f', emoji: '🌾' },
    5: { name: 'Ore', color: '#6b6b6b', emoji: '🪨' }
  };

  // C&K commodities (card types 6, 7, 8)
  const COMMODITY_TYPES = {
    6: { name: 'Cloth', color: '#9b59b6', emoji: '🧶', fromResource: 3 },  // From Sheep
    7: { name: 'Coin', color: '#f1c40f', emoji: '🪙', fromResource: 5 },   // From Ore
    8: { name: 'Paper', color: '#ecf0f1', emoji: '📜', fromResource: 1 }   // From Wood
  };

  // Mapping from resource type to commodity type for C&K cities
  const RESOURCE_TO_COMMODITY = {
    3: 6,  // Sheep -> Cloth
    5: 7,  // Ore -> Coin
    1: 8   // Wood -> Paper
  };

  const PLAYER_COLORS = {
    1: { name: 'Red', hex: '#e74c3c' },
    2: { name: 'Blue', hex: '#3498db' },
    3: { name: 'Orange', hex: '#e67e22' },
    4: { name: 'White', hex: '#ecf0f1' }
  };

  // Get active players from playerStates
  function getActivePlayers() {
    if (!gameStore) return [];
    const gs = gameStore.getState().gameState;
    const playerStates = gs.playerStates;
    if (!playerStates) return [1, 2, 3, 4]; // fallback
    return Object.keys(playerStates)
      .map(k => parseInt(k))
      .filter(id => id >= 1 && id <= 4 && playerStates[id]);
  }

  // Detect if this is a Cities & Knights game
  function isCitiesAndKnights() {
    if (!gameStore) return false;
    const gs = gameStore.getState().gameState;
    // C&K games have barbarianInvasionState or mechanicBarbarianInvasionState
    return !!(gs.mechanicBarbarianInvasionState || gs.barbarianInvasionState);
  }

  // Get card discard limit for a player (7 in base game, can be higher in C&K with city walls)
  function getCardDiscardLimit(playerColor) {
    if (!gameStore) return 7;
    const gs = gameStore.getState().gameState;
    const playerState = gs.playerStates?.[playerColor];
    // C&K stores cardDiscardLimit per player (increases with city walls)
    if (playerState?.cardDiscardLimit !== undefined) {
      return playerState.cardDiscardLimit;
    }
    return 7; // default
  }

  // Get current card count for a player directly from state
  function getPlayerCardCount(playerColor) {
    if (!gameStore) return 0;
    const gs = gameStore.getState().gameState;
    const playerState = gs.playerStates?.[playerColor];
    if (!playerState?.resourceCards?.cards) return 0;
    return playerState.resourceCards.cards.length;
  }

  // Get all current card counts
  function getAllCardCounts() {
    const counts = {};
    getActivePlayers().forEach(p => {
      counts[p] = getPlayerCardCount(p);
    });
    return counts;
  }

  // Update roll history when new rolls occur - called on each state change
  function updateRollHistory() {
    if (!gameStore) return;
    const rolls = getDiceRolls();

    // Check if new rolls have occurred
    if (rolls.length > lastKnownRollCount) {
      // Get current card counts BEFORE they change from this roll's distribution
      // Note: This captures state right when we detect the roll, which should be
      // after the roll but before resources are distributed (or right after)
      const currentCounts = getAllCardCounts();

      // Add any new rolls to history
      for (let i = lastKnownRollCount; i < rolls.length; i++) {
        const roll = rolls[i];
        rollHistory.push({
          turn: roll.turn,
          diceSum: roll.sum,
          player: roll.player,
          // Snapshot card counts at this roll
          // For the most recent roll, use current state
          // For older rolls we missed, we don't have accurate data
          cardCounts: i === rolls.length - 1 ? { ...currentCounts } : null
        });
      }
      lastKnownRollCount = rolls.length;
    }
  }

  // Reset history (for new games)
  function resetRollHistory() {
    rollHistory = [];
    lastKnownRollCount = 0;
  }

  function diceProbability(n) {
    return n === 0 ? 0 : (6 - Math.abs(n - 7)) / 36;
  }

  function normalCDF(z) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = z < 0 ? -1 : 1;
    z = Math.abs(z) / Math.sqrt(2);
    const t = 1 / (1 + p * z);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
    return 0.5 * (1 + sign * y);
  }

  function calcLuckProbability(playerColor, rolls) {
    const buildings = getPlayerBuildings(playerColor);
    if (buildings.length === 0 || rolls.length === 0) {
      return { zScore: 0, percentile: 50, pValue: 1, confidence: 'none', nRolls: rolls.length };
    }

    // Calculate expected value and variance per roll
    let expectedPerRoll = 0, variancePerRoll = 0;
    buildings.forEach(b => {
      b.hexes.forEach(hex => {
        const p = hex.probability, m = b.multiplier;
        expectedPerRoll += p * m;
        // Var(X) = E[X^2] - E[X]^2 = p*m^2 - (p*m)^2 = p*m^2*(1-p)
        variancePerRoll += p * (1 - p) * m * m;
      });
    });

    if (variancePerRoll === 0) return { zScore: 0, percentile: 50, pValue: 1, confidence: 'none', nRolls: rolls.length };

    // Calculate actual resources received
    let actual = 0;
    rolls.forEach(roll => { actual += calcResourcesForRoll(playerColor, roll.sum).total; });

    const totalExpected = expectedPerRoll * rolls.length;
    // Variance scales linearly with n (independent rolls), stdDev scales with sqrt(n)
    const totalVariance = variancePerRoll * rolls.length;
    const stdDev = Math.sqrt(totalVariance);

    const zScore = (actual - totalExpected) / stdDev;
    const percentile = normalCDF(zScore) * 100;
    const pValue = 2 * (1 - normalCDF(Math.abs(zScore)));

    // Confidence level based on sample size - how much we can trust the percentile
    // With few rolls, even extreme percentiles aren't very meaningful
    let confidence = 'low';
    if (rolls.length >= 30) confidence = 'high';
    else if (rolls.length >= 15) confidence = 'medium';
    else if (rolls.length >= 5) confidence = 'low';
    else confidence = 'very_low';

    return {
      zScore,
      percentile,
      pValue,
      actual,
      expected: totalExpected,
      stdDev,
      confidence,
      nRolls: rolls.length
    };
  }

  function findReactFiber(dom) {
    if (!dom) return null;
    const key = Object.keys(dom).find(k => k.startsWith('__reactFiber$'));
    return key ? dom[key] : null;
  }

  function findGameStore(fiber, depth = 0, maxDepth = 30, visited = new Set()) {
    if (!fiber || depth > maxDepth || visited.has(fiber)) return null;
    visited.add(fiber);
    try { if (fiber.memoizedProps?.gameStore) return fiber.memoizedProps.gameStore; } catch (e) {}
    return findGameStore(fiber.return, depth + 1, maxDepth, visited) ||
           findGameStore(fiber.child, depth + 1, maxDepth, visited) ||
           findGameStore(fiber.sibling, depth + 1, maxDepth, visited);
  }

  function getAdjacentHexes(corner, hexes) {
    const { x, y, z } = corner;
    const adjacentCoords = z === 0
      ? [{ x, y }, { x, y: y - 1 }, { x: x + 1, y: y - 1 }]
      : [{ x, y }, { x: x - 1, y: y + 1 }, { x, y: y + 1 }];
    return adjacentCoords
      .map(c => Object.values(hexes).find(h => h.x === c.x && h.y === c.y))
      .filter(h => h && h.type !== 0);
  }

  function getPlayerBuildings(playerColor) {
    if (!gameStore) return [];
    const gs = gameStore.getState().gameState;
    const corners = gs.mapState.tileCornerStates;
    const hexes = gs.mapState.tileHexStates;
    const buildings = [];
    Object.values(corners).forEach(corner => {
      if (corner.owner !== playerColor) return;
      const adjHexes = getAdjacentHexes(corner, hexes);
      buildings.push({
        id: corner.id,
        type: corner.buildingType === 2 ? 'City' : 'Settlement',
        multiplier: corner.buildingType === 2 ? 2 : 1,
        coords: { x: corner.x, y: corner.y, z: corner.z },
        hexes: adjHexes.map(h => ({
          type: h.type,
          resource: RESOURCE_TYPES[h.type]?.name || 'Unknown',
          diceNumber: h.diceNumber,
          probability: diceProbability(h.diceNumber)
        }))
      });
    });
    return buildings;
  }

  function calcExpectedByResource(playerColor) {
    const buildings = getPlayerBuildings(playerColor);
    const isCK = isCitiesAndKnights();
    const expected = { total: 0 };
    // Initialize resources
    Object.keys(RESOURCE_TYPES).forEach(t => { if (t !== '0') expected[t] = 0; });
    // Initialize commodities for C&K
    if (isCK) {
      Object.keys(COMMODITY_TYPES).forEach(t => { expected[t] = 0; });
    }

    buildings.forEach(b => {
      const isCity = b.type === 'City';
      b.hexes.forEach(hex => {
        const prob = hex.probability;
        const resType = hex.type;
        const commodityType = RESOURCE_TO_COMMODITY[resType];

        if (isCity && isCK && commodityType) {
          // C&K city on commodity-producing hex: 1 resource + 1 commodity expected
          expected[resType] = (expected[resType] || 0) + prob;
          expected[commodityType] = (expected[commodityType] || 0) + prob;
          expected.total += prob * 2;
        } else {
          // Settlement: 1 resource
          // City (base game or non-commodity hex): 2 resources
          const multiplier = b.multiplier;
          expected[resType] = (expected[resType] || 0) + prob * multiplier;
          expected.total += prob * multiplier;
        }
      });
    });
    return expected;
  }

  function getDiceRolls() {
    if (!gameStore) return [];
    const gs = gameStore.getState().gameState;
    const log = gs.gameLogState;
    const rolls = Object.entries(log)
      .filter(([_, e]) => e.text?.type === 10)
      .map(([idx, e]) => ({
        logIndex: parseInt(idx),
        dice1: e.text.firstDice,
        dice2: e.text.secondDice,
        sum: e.text.firstDice + e.text.secondDice,
        player: e.from
      }))
      .sort((a, b) => a.logIndex - b.logIndex);

    // Add turn number (1-indexed sequential roll number)
    return rolls.map((r, i) => ({ ...r, turn: i + 1 }));
  }

  function calcResourcesForRoll(playerColor, diceSum) {
    if (!gameStore) return { total: 0 };
    const gs = gameStore.getState().gameState;
    const corners = gs.mapState.tileCornerStates;
    const hexes = gs.mapState.tileHexStates;
    const isCK = isCitiesAndKnights();
    const resources = { total: 0 };
    // Initialize all resource types
    Object.keys(RESOURCE_TYPES).forEach(t => { if (t !== '0') resources[t] = 0; });
    // Initialize commodity types for C&K
    if (isCK) {
      Object.keys(COMMODITY_TYPES).forEach(t => { resources[t] = 0; });
    }

    Object.values(corners).forEach(corner => {
      if (corner.owner !== playerColor) return;
      const isCity = corner.buildingType === 2;
      getAdjacentHexes(corner, hexes).forEach(hex => {
        if (hex.diceNumber === diceSum) {
          const resType = hex.type;
          const commodityType = RESOURCE_TO_COMMODITY[resType];

          if (isCity && isCK && commodityType) {
            // C&K city on commodity-producing hex: 1 resource + 1 commodity
            resources[resType] = (resources[resType] || 0) + 1;
            resources[commodityType] = (resources[commodityType] || 0) + 1;
            resources.total += 2;
          } else {
            // Settlement: 1 resource
            // City (base game or non-commodity hex): 2 resources
            const multiplier = isCity ? 2 : 1;
            resources[resType] = (resources[resType] || 0) + multiplier;
            resources.total += multiplier;
          }
        }
      });
    });
    return resources;
  }

  // Analyze 7s - uses stateful roll history for accurate vulnerability tracking
  function analyzeSevens() {
    if (!gameStore) return { totalRolls: 0, sevenCount: 0, playerSevenStats: {} };
    const gs = gameStore.getState().gameState;
    const logState = gs.gameLogState;
    const activePlayers = getActivePlayers();

    // Get discard events from log (reliable)
    const entries = Object.entries(logState)
      .map(([idx, e]) => ({ idx: parseInt(idx), ...e }))
      .sort((a, b) => a.idx - b.idx);

    // Track per-player stats
    const playerStats = {};
    activePlayers.forEach(p => {
      const discardLimit = getCardDiscardLimit(p);
      playerStats[p] = {
        rollsWhileVulnerable: 0,
        sevensWhileVulnerable: 0,
        expectedSevens: 0,
        timesDiscarded: 0,
        cardsDiscarded: 0,
        sevenLuck: 0,
        currentCards: getPlayerCardCount(p),
        discardLimit: discardLimit  // Track per-player limit (for city walls)
      };
    });

    // Count discards from log
    entries.forEach(entry => {
      const t = entry.text;
      if (!t) return;
      const pc = t.playerColor;
      if (t.type === 55 && t.cardEnums && pc && playerStats[pc]) {
        playerStats[pc].timesDiscarded++;
        playerStats[pc].cardsDiscarded += t.cardEnums.length;
      }
    });

    // Use roll history for vulnerability tracking (stateful snapshots)
    const sevenRolls = [];
    let rollsWithData = 0;

    rollHistory.forEach(roll => {
      if (roll.diceSum === 7) {
        sevenRolls.push({ turn: roll.turn, player: roll.player });
      }

      // Only count rolls where we have card count data
      if (roll.cardCounts) {
        rollsWithData++;
        activePlayers.forEach(p => {
          const cards = roll.cardCounts[p];
          const limit = playerStats[p].discardLimit;
          // Vulnerable if cards > discard limit (7 in base, higher with city walls)
          if (cards !== undefined && cards > limit) {
            playerStats[p].rollsWhileVulnerable++;
            playerStats[p].expectedSevens += 6 / 36;
            if (roll.diceSum === 7) {
              playerStats[p].sevensWhileVulnerable++;
            }
          }
        });
      }
    });

    // Calculate luck
    activePlayers.forEach(p => {
      playerStats[p].sevenLuck = playerStats[p].sevensWhileVulnerable - playerStats[p].expectedSevens;
      playerStats[p].currentCards = getPlayerCardCount(p);
    });

    const totalRolls = rollHistory.length;
    const sevenCount = sevenRolls.length;
    const expectedSevens = totalRolls * (6 / 36);

    return {
      totalRolls,
      sevenCount,
      expectedSevens: expectedSevens.toFixed(1),
      aboveExpectedSevens: (sevenCount - expectedSevens).toFixed(1),
      actualSevenRate: totalRolls > 0 ? ((sevenCount / totalRolls) * 100).toFixed(1) + '%' : '—',
      sevenRolls,
      playerSevenStats: playerStats,
      activePlayers,
      rollsWithData // How many rolls have card count snapshots
    };
  }

  function calcDetailedStats(playerColor) {
    const rolls = getDiceRolls();
    const expectedPerTurn = calcExpectedByResource(playerColor);
    const isCK = isCitiesAndKnights();
    let cumActual = { total: 0 }, cumExpected = { total: 0 };
    // Initialize resources
    Object.keys(RESOURCE_TYPES).forEach(t => { if (t !== '0') { cumActual[t] = 0; cumExpected[t] = 0; } });
    // Initialize commodities for C&K
    if (isCK) {
      Object.keys(COMMODITY_TYPES).forEach(t => { cumActual[t] = 0; cumExpected[t] = 0; });
    }

    const allTypes = isCK ? { ...RESOURCE_TYPES, ...COMMODITY_TYPES } : RESOURCE_TYPES;

    const history = rolls.map((roll, i) => {
      const actualThisRoll = calcResourcesForRoll(playerColor, roll.sum);
      cumActual.total += actualThisRoll.total;
      Object.keys(allTypes).forEach(t => {
        if (t !== '0') {
          cumActual[t] += actualThisRoll[t] || 0;
          cumExpected[t] += expectedPerTurn[t] || 0;
        }
      });
      cumExpected.total += expectedPerTurn.total;
      return {
        turn: i + 1, roll: roll.sum, rolledBy: roll.player,
        actualThisRoll: actualThisRoll.total, expectedThisRoll: expectedPerTurn.total,
        cumActual: cumActual.total, cumExpected: cumExpected.total,
        aboveExpected: cumActual.total - cumExpected.total
      };
    });
    return { history, cumActual: { ...cumActual }, cumExpected: { ...cumExpected }, expectedPerTurn, buildings: getPlayerBuildings(playerColor) };
  }

  function getAllPlayersStats() {
    const rolls = getDiceRolls();
    const activePlayers = getActivePlayers();
    return activePlayers.map(c => {
      const stats = calcDetailedStats(c);
      const last = stats.history[stats.history.length - 1];
      const luckProb = calcLuckProbability(c, rolls);
      const currentCards = getPlayerCardCount(c);
      return {
        player: c, color: PLAYER_COLORS[c].name, colorHex: PLAYER_COLORS[c].hex,
        expectedPerTurn: stats.expectedPerTurn.total.toFixed(3),
        totalReceived: last?.cumActual || 0,
        totalExpected: last?.cumExpected.toFixed(2) || '0',
        aboveExpected: last ? (last.cumActual - last.cumExpected).toFixed(2) : '0',
        byResource: stats.cumActual, expectedByResource: stats.cumExpected, history: stats.history,
        luckProb,
        currentCards
      };
    });
  }

  function log(message, data = null) {
    const entry = { time: new Date().toLocaleTimeString(), message, data: data ? JSON.stringify(data, null, 2) : null };
    debugLog.push(entry);
    if (debugLog.length > 500) debugLog.shift();
    console.log('[PearsonRAE] ' + message, data || '');
  }

  function createOverlay() {
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'pearson-rae-overlay';
    updateOverlayStyle();
    document.body.appendChild(overlay);
    return overlay;
  }

  function updateOverlayStyle() {
    if (!overlay) return;
    if (isCollapsed) {
      overlay.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;background:rgba(20,20,35,0.95);color:#fff;padding:8px 12px;border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,0.3);cursor:pointer;user-select:none;backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.1);';
    } else {
      overlay.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;background:rgba(20,20,35,0.95);color:#fff;padding:14px;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12px;width:320px;max-height:85vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.4);user-select:none;backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.1);';
    }
  }

  function toggleCollapse() {
    isCollapsed = !isCollapsed;
    updateOverlayStyle();
    updateOverlay();
  }

  window._pearsonRAEToggle = toggleCollapse;

  function renderTabs() {
    const tabs = [
      { id: 'main', label: 'Main' },
      { id: 'resources', label: 'Res' },
      { id: 'graph', label: 'Graph' },
      { id: 'sevens', label: '7s' },
      { id: 'debug', label: 'Debug' }
    ];
    return '<div style="display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap;align-items:center;">' +
      `<button onclick="window._pearsonRAEToggle()" style="padding:6px 8px;background:rgba(255,255,255,0.1);color:#888;border:none;border-radius:6px;cursor:pointer;font-size:12px;margin-right:4px;">◀</button>` +
      tabs.map(t => `<button onclick="window._rollsTrackerSetView('${t.id}')" style="padding:5px 10px;font-size:10px;cursor:pointer;background:${currentView === t.id ? 'linear-gradient(135deg,#667eea,#764ba2)' : 'rgba(255,255,255,0.1)'};color:#fff;border:none;border-radius:6px;font-weight:${currentView === t.id ? '600' : '400'};transition:all 0.2s;">${t.label}</button>`).join('') +
      '</div>';
  }

  function renderCollapsedView() {
    const stats = getAllPlayersStats();
    const best = stats.reduce((a, b) => parseFloat(a.aboveExpected) > parseFloat(b.aboveExpected) ? a : b, stats[0]);
    const worst = stats.reduce((a, b) => parseFloat(a.aboveExpected) < parseFloat(b.aboveExpected) ? a : b, stats[0]);
    return `
      <div onclick="window._pearsonRAEToggle()" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
        <span style="font-size:14px;">▶</span>
        <span style="font-weight:600;color:#888;">RAE</span>
        <span style="color:${best?.colorHex};font-size:11px;">${best?.color?.[0]}:+${best?.aboveExpected}</span>
        <span style="color:${worst?.colorHex};font-size:11px;">${worst?.color?.[0]}:${worst?.aboveExpected}</span>
      </div>`;
  }

  function formatLuckIndicator(luckProb) {
    if (!luckProb || luckProb.pValue === 1) return '';
    const pct = luckProb.percentile;
    let color = '#888';
    if (pct >= 95) color = '#2ecc71';
    else if (pct >= 80) color = '#27ae60';
    else if (pct <= 5) color = '#e74c3c';
    else if (pct <= 20) color = '#c0392b';
    return `<span style="color:${color};font-size:10px;margin-left:4px;">${pct.toFixed(0)}%ile</span>`;
  }

  function renderMainView(stats, rolls) {
    if (stats.length === 0) {
      return '<div style="text-align:center;padding:30px;color:#666;">Waiting for game data...</div>';
    }

    let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <span style="color:#666;font-size:11px;">${rolls.length} rolls</span>
    </div>`;

    html += '<div style="display:flex;flex-direction:column;gap:10px;">';
    stats.forEach(s => {
      const aboveExp = parseFloat(s.aboveExpected);
      const isPositive = aboveExp >= 0;
      const lp = s.luckProb;
      const pct = lp?.percentile;
      const conf = lp?.confidence;

      // Color based on how extreme AND how confident
      let pctColor = '#666';
      if (conf && conf !== 'very_low' && conf !== 'none') {
        if (pct >= 90) pctColor = '#27ae60';
        else if (pct >= 75) pctColor = '#2ecc71';
        else if (pct <= 10) pctColor = '#c0392b';
        else if (pct <= 25) pctColor = '#e74c3c';
      }

      // Confidence indicator
      const confDots = conf === 'high' ? '●●●' : conf === 'medium' ? '●●○' : conf === 'low' ? '●○○' : '○○○';
      const confTitle = conf === 'high' ? 'High confidence (30+ rolls)' :
                        conf === 'medium' ? 'Medium confidence (15-29 rolls)' :
                        conf === 'low' ? 'Low confidence (5-14 rolls)' : 'Very low confidence (<5 rolls)';

      html += `
        <div style="background:rgba(255,255,255,0.05);border-radius:8px;padding:12px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
            <div>
              <span style="color:${s.colorHex};font-weight:600;font-size:13px;">${s.color}</span>
              <span style="color:#555;font-size:10px;margin-left:6px;">${s.currentCards} cards</span>
            </div>
            <div style="text-align:right;">
              <div style="font-size:20px;font-weight:700;color:${isPositive ? '#2ecc71' : '#e74c3c'};line-height:1;">
                ${isPositive ? '+' : ''}${s.aboveExpected}
              </div>
              ${pct !== undefined ? `<div style="font-size:10px;color:${pctColor};margin-top:2px;" title="${confTitle}">
                ${pct.toFixed(0)}th %ile <span style="font-size:8px;letter-spacing:-1px;color:#555;">${confDots}</span>
              </div>` : ''}
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:#888;">
            <span>Got <span style="color:#fff;">${s.totalReceived}</span></span>
            <span>Expected <span style="color:#aaa;">${s.totalExpected}</span></span>
            <span style="color:#555;">${s.expectedPerTurn}/roll</span>
          </div>
        </div>`;
    });
    html += '</div>';
    return html;
  }

  function renderResourcesView(stats) {
    if (stats.length === 0) {
      return '<div style="text-align:center;padding:30px;color:#666;">Waiting for game data...</div>';
    }

    const isCK = isCitiesAndKnights();
    const resourceTypes = [1, 2, 3, 4, 5];
    const commodityTypes = isCK ? [6, 7, 8] : [];
    const allTypes = { ...RESOURCE_TYPES, ...COMMODITY_TYPES };

    let html = '<div style="display:flex;flex-direction:column;gap:10px;">';
    stats.forEach(s => {
      html += `<div style="background:rgba(255,255,255,0.05);border-radius:8px;padding:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="color:${s.colorHex};font-weight:600;font-size:12px;">${s.color}</span>
          <span style="color:#555;font-size:10px;">${s.totalReceived} total</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:4px;">`;
      resourceTypes.forEach(resType => {
        const resInfo = allTypes[resType];
        const got = s.byResource[resType] || 0;
        const exp = s.expectedByResource[resType] || 0;
        const diff = got - exp;
        html += `
          <div style="text-align:center;padding:6px 4px;background:rgba(0,0,0,0.2);border-radius:4px;">
            <div style="font-size:14px;">${resInfo.emoji}</div>
            <div style="font-size:13px;font-weight:600;color:#fff;">${got}</div>
            <div style="font-size:9px;color:${diff >= 0 ? '#2ecc71' : '#e74c3c'};">${diff >= 0 ? '+' : ''}${diff.toFixed(1)}</div>
          </div>`;
      });
      html += '</div>';

      // Show commodities row for C&K
      if (isCK) {
        html += `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-top:6px;">`;
        commodityTypes.forEach(comType => {
          const comInfo = allTypes[comType];
          const got = s.byResource[comType] || 0;
          const exp = s.expectedByResource[comType] || 0;
          const diff = got - exp;
          html += `
            <div style="text-align:center;padding:6px 4px;background:rgba(155,89,182,0.15);border-radius:4px;">
              <div style="font-size:14px;">${comInfo.emoji}</div>
              <div style="font-size:13px;font-weight:600;color:#fff;">${got}</div>
              <div style="font-size:9px;color:${diff >= 0 ? '#2ecc71' : '#e74c3c'};">${diff >= 0 ? '+' : ''}${diff.toFixed(1)}</div>
            </div>`;
        });
        html += '</div>';
      }
      html += '</div>';
    });
    return html + '</div>';
  }

  function renderGraphView(stats) {
    const width = 290, height = 180;
    const padding = { top: 15, right: 10, bottom: 25, left: 35 };
    const graphWidth = width - padding.left - padding.right;
    const graphHeight = height - padding.top - padding.bottom;

    const maxTurns = Math.max(...stats.map(s => s.history.length), 1);
    let minVal = 0, maxVal = 0;
    stats.forEach(s => { s.history.forEach(h => { minVal = Math.min(minVal, h.aboveExpected); maxVal = Math.max(maxVal, h.aboveExpected); }); });

    const range = Math.max(maxVal - minVal, 2);
    minVal -= range * 0.1; maxVal += range * 0.1;
    const finalRange = maxVal - minVal;

    const scaleX = (i) => padding.left + (i / (maxTurns - 1 || 1)) * graphWidth;
    const scaleY = (v) => padding.top + graphHeight * ((maxVal - v) / finalRange);
    const zeroY = scaleY(0);

    let svg = `<svg width="${width}" height="${height}" style="display:block;margin:0 auto;">`;
    svg += `<rect width="${width}" height="${height}" fill="#1a1a2e" rx="8"/>`;

    for (let i = 0; i <= 5; i++) {
      const y = padding.top + (graphHeight / 5) * i;
      const val = maxVal - (finalRange / 5) * i;
      svg += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>`;
      svg += `<text x="${padding.left - 8}" y="${y + 4}" fill="#666" font-size="9" text-anchor="end">${val.toFixed(1)}</text>`;
    }

    if (minVal < 0 && maxVal > 0) {
      svg += `<line x1="${padding.left}" y1="${zeroY}" x2="${width - padding.right}" y2="${zeroY}" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" stroke-dasharray="4,4"/>`;
    }

    stats.forEach(s => {
      if (s.history.length < 2) return;
      let pathD = '';
      s.history.forEach((h, i) => {
        const x = scaleX(i), y = scaleY(h.aboveExpected);
        pathD += i === 0 ? `M${x},${y}` : ` L${x},${y}`;
      });
      svg += `<path d="${pathD}" fill="none" stroke="rgba(0,0,0,0.3)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
      svg += `<path d="${pathD}" fill="none" stroke="${s.colorHex}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
      if (s.history.length > 0) {
        const lastH = s.history[s.history.length - 1];
        svg += `<circle cx="${scaleX(s.history.length - 1)}" cy="${scaleY(lastH.aboveExpected)}" r="4" fill="${s.colorHex}" stroke="#1a1a2e" stroke-width="2"/>`;
      }
    });
    svg += '</svg>';

    let legend = '<div style="display:flex;justify-content:center;gap:12px;margin-top:10px;">';
    stats.forEach(s => {
      const last = s.history[s.history.length - 1];
      const val = last ? last.aboveExpected.toFixed(1) : '0';
      const isPos = parseFloat(val) >= 0;
      legend += `<div style="display:flex;align-items:center;gap:4px;">
        <div style="width:10px;height:10px;background:${s.colorHex};border-radius:2px;"></div>
        <span style="font-size:10px;color:${isPos ? '#2ecc71' : '#e74c3c'};">${isPos ? '+' : ''}${val}</span>
      </div>`;
    });
    legend += '</div>';

    return `<div style="text-align:center;margin-bottom:8px;color:#666;font-size:10px;">Luck over time (rolls above/below expected)</div>${svg}${legend}`;
  }

  function renderSevensView() {
    const sevensData = analyzeSevens();
    const aboveExp = parseFloat(sevensData.aboveExpectedSevens);
    const activePlayers = sevensData.activePlayers || getActivePlayers();

    let html = `
      <div style="display:flex;gap:12px;margin-bottom:14px;">
        <div style="flex:1;background:rgba(255,255,255,0.05);border-radius:8px;padding:12px;text-align:center;">
          <div style="font-size:28px;font-weight:700;color:#fff;">${sevensData.sevenCount}</div>
          <div style="font-size:10px;color:#666;margin-top:2px;">7s rolled</div>
        </div>
        <div style="flex:1;background:rgba(255,255,255,0.05);border-radius:8px;padding:12px;text-align:center;">
          <div style="font-size:28px;font-weight:700;color:#666;">${sevensData.expectedSevens}</div>
          <div style="font-size:10px;color:#666;margin-top:2px;">expected</div>
        </div>
        <div style="flex:1;background:rgba(255,255,255,0.05);border-radius:8px;padding:12px;text-align:center;">
          <div style="font-size:28px;font-weight:700;color:${aboveExp >= 0 ? '#e74c3c' : '#2ecc71'};">${aboveExp >= 0 ? '+' : ''}${sevensData.aboveExpectedSevens}</div>
          <div style="font-size:10px;color:#666;margin-top:2px;">${sevensData.actualSevenRate}</div>
        </div>
      </div>`;

    // Show tracking status
    const trackedRolls = sevensData.rollsWithData || 0;
    if (trackedRolls < sevensData.totalRolls) {
      html += `<div style="font-size:10px;color:#666;margin-bottom:10px;text-align:center;">
        Tracking ${trackedRolls}/${sevensData.totalRolls} rolls (started mid-game)
      </div>`;
    }

    // Per-player vulnerability stats
    html += '<div style="display:flex;flex-direction:column;gap:8px;">';

    activePlayers.forEach(p => {
      const ps = sevensData.playerSevenStats[p];
      if (!ps) return;
      const pc = PLAYER_COLORS[p];
      const limit = ps.discardLimit || 7;
      const isVulnerable = ps.currentCards > limit;
      const luck = ps.sevenLuck;
      const hasWallBonus = limit > 7;

      html += `
        <div style="background:rgba(255,255,255,0.05);border-radius:8px;padding:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="color:${pc.hex};font-weight:600;">${pc.name}</span>
              <span style="font-size:12px;padding:3px 8px;border-radius:4px;background:${isVulnerable ? 'rgba(231,76,60,0.3)' : 'rgba(255,255,255,0.08)'};color:${isVulnerable ? '#e74c3c' : '#aaa'};font-weight:600;">
                ${ps.currentCards}/${limit}${hasWallBonus ? '🏰' : ''}${isVulnerable ? ' ⚠️' : ''}
              </span>
            </div>
            <span style="font-size:13px;font-weight:600;color:${luck < -0.1 ? '#2ecc71' : luck > 0.1 ? '#e74c3c' : '#666'};">
              ${luck > 0 ? '+' : ''}${luck.toFixed(1)}
            </span>
          </div>
          ${ps.rollsWhileVulnerable > 0 ? `
          <div style="margin-top:8px;display:flex;gap:16px;font-size:10px;color:#888;">
            <div><span style="color:#fff;">${ps.rollsWhileVulnerable}</span> vulnerable rolls</div>
            <div><span style="color:#fff;">${ps.sevensWhileVulnerable}</span>/${ps.expectedSevens.toFixed(1)} 7s hit</div>
            ${ps.timesDiscarded > 0 ? `<div style="color:#e74c3c;">${ps.cardsDiscarded} discarded</div>` : ''}
          </div>` : `
          <div style="margin-top:6px;font-size:10px;color:#555;">
            ${ps.timesDiscarded > 0 ? `<span style="color:#e74c3c;">${ps.timesDiscarded}× discarded (${ps.cardsDiscarded} cards)</span>` : 'No vulnerable rolls tracked'}
          </div>`}
        </div>`;
    });
    html += '</div>';

    return html;
  }

  function renderDebugView(stats) {
    const activePlayers = getActivePlayers();

    let html = `<div style="margin-bottom:10px;">
      <button onclick="window._rollsTrackerRefreshDebug()" style="padding:6px 10px;background:rgba(255,255,255,0.1);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:10px;margin-right:4px;">Refresh</button>
      <button onclick="window._rollsTrackerCopyDebug()" style="padding:6px 10px;background:rgba(255,255,255,0.1);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:10px;">Copy</button>
      <span style="color:#555;font-size:10px;margin-left:8px;">${activePlayers.length} players</span>
    </div>`;

    html += '<div style="font-size:10px;font-weight:600;margin:8px 0 4px;color:#666;">Buildings & Stats</div>';
    html += '<div style="background:rgba(0,0,0,0.3);padding:8px;border-radius:4px;font-size:9px;max-height:150px;overflow-y:auto;font-family:monospace;">';

    stats.forEach(s => {
      const detail = calcDetailedStats(s.player);
      html += `<div style="margin-bottom:8px;">
        <div style="color:${s.colorHex};font-weight:600;">${s.color} <span style="color:#555;">(${s.currentCards} cards)</span></div>
        <div style="color:#555;margin-left:8px;">`;
      detail.buildings.forEach(b => {
        html += `${b.type[0]}: ${b.hexes.map(h => `${h.resource[0]}${h.diceNumber}`).join(' ')}<br>`;
      });
      const ae = parseFloat(s.aboveExpected);
      html += `<span style="color:#888;">E:${s.expectedPerTurn}/r</span> | Got:${s.totalReceived} Exp:${s.totalExpected} | <span style="color:${ae >= 0 ? '#2ecc71' : '#e74c3c'};">${ae >= 0 ? '+' : ''}${s.aboveExpected}</span>`;
      if (s.luckProb?.percentile) html += ` | ${s.luckProb.percentile.toFixed(0)}%`;
      html += '</div></div>';
    });
    html += '</div>';

    html += '<div style="font-size:10px;font-weight:600;margin:8px 0 4px;color:#666;">Recent Rolls</div>';
    html += '<div style="background:rgba(0,0,0,0.3);padding:8px;border-radius:4px;font-size:9px;max-height:100px;overflow-y:auto;font-family:monospace;">';
    getDiceRolls().slice(-12).reverse().forEach(roll => {
      const pc = PLAYER_COLORS[roll.player];
      html += `<div><span style="color:#555;">#${roll.turn}:</span> <span style="color:${pc?.hex || '#888'};">${pc?.name?.[0] || '?'}</span> ${roll.sum}`;
      activePlayers.forEach(p => {
        const res = calcResourcesForRoll(p, roll.sum);
        if (res.total > 0) html += ` <span style="color:${PLAYER_COLORS[p].hex};">${PLAYER_COLORS[p].name[0]}+${res.total}</span>`;
      });
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  function updateOverlay() {
    if (!overlay || !gameStore) return;
    // Update roll history with card count snapshots
    updateRollHistory();

    if (isCollapsed) {
      overlay.innerHTML = renderCollapsedView();
      return;
    }

    const stats = getAllPlayersStats();
    const rolls = getDiceRolls();
    let html = renderTabs();
    switch (currentView) {
      case 'main': html += renderMainView(stats, rolls); break;
      case 'resources': html += renderResourcesView(stats); break;
      case 'graph': html += renderGraphView(stats); break;
      case 'sevens': html += renderSevensView(); break;
      case 'debug': html += renderDebugView(stats); break;
    }
    overlay.innerHTML = html;
  }

  window._rollsTrackerSetView = function(view) { currentView = view; updateOverlay(); };
  window._rollsTrackerRefreshDebug = function() { log('Manual refresh triggered'); updateOverlay(); };
  window._rollsTrackerCopyDebug = function() {
    const stats = getAllPlayersStats();
    const debugData = { timestamp: new Date().toISOString(), rolls: getDiceRolls(), sevens: analyzeSevens(), players: stats.map(s => ({ ...s, buildings: calcDetailedStats(s.player).buildings })), log: debugLog.slice(-50) };
    navigator.clipboard.writeText(JSON.stringify(debugData, null, 2)).then(() => alert('Debug data copied!')).catch(e => console.error('Copy failed:', e));
  };

  function init() {
    log('Initializing tracker...');
    const el = document.querySelector('[class*="gameBottomContainer"]') || document.querySelector('[class*="gameTopLeftContainer"]');
    if (!el) { log('Game container not found, retrying...'); setTimeout(init, 2000); return; }
    const fiber = findReactFiber(el);
    if (!fiber) { log('No React fiber, retrying...'); setTimeout(init, 2000); return; }
    gameStore = findGameStore(fiber);
    if (!gameStore) { log('GameStore not found, retrying...'); setTimeout(init, 2000); return; }
    log('Game store found, creating overlay');
    createOverlay();
    updateOverlay();
    if (unsubscribe) unsubscribe();
    unsubscribe = gameStore.subscribe(() => updateOverlay());
    setInterval(() => { if (!document.getElementById('pearson-rae-overlay')) { createOverlay(); updateOverlay(); } }, 5000);
    log('PearsonRAE initialized successfully');
  }

  window.PearsonRAE = { getStats: getAllPlayersStats, getRolls: getDiceRolls, getSevens: analyzeSevens, getDebugLog: () => debugLog, getDetailedStats: calcDetailedStats, refresh: init, toggle: toggleCollapse, isCK: isCitiesAndKnights };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 2000));
  else setTimeout(init, 2000);

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // Reset stateful tracking for new game
      resetRollHistory();
      setTimeout(init, 2000);
    }
  }).observe(document, { subtree: true, childList: true });
})();
