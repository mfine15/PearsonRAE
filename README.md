# PearsonRAE

**Rolls Above Expectation** tracker for [Colonist.io](https://colonist.io)

A Chrome extension that tracks your luck in Catan by calculating how many resources you've received compared to statistical expectation based on your settlements and cities.

Supports both **Base Catan** and **Cities & Knights** expansion.

## Features

- **RAE Tracking** - Shows cumulative resources received vs expected for each player
- **Percentile Ranking** - Statistical confidence indicator showing how lucky/unlucky outcomes are
- **Per-Resource Breakdown** - See luck by individual resource type (and commodities in C&K)
- **Graph View** - Visualize luck over time with SVG chart
- **7s Tracking** - Track vulnerability, discards, and 7s luck (respects city wall bonuses)
- **Collapsible UI** - Right-side overlay that collapses to show just a summary
- **Cities & Knights Support** - Tracks commodities (cloth, coin, paper) and adjusted city production

## Installation

1. Clone this repository or download the files
2. Open Chrome and go to `chrome://extensions`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked" and select this folder
5. Go to [colonist.io](https://colonist.io) and join a game

## Usage

The overlay appears automatically on the right side when you're in a game.

- Click `◀` to collapse the overlay
- Click `▶` to expand it
- Use the tabs to switch between views:
  - **Main** - Overall luck per player with percentile
  - **Res** - Per-resource breakdown
  - **Graph** - Luck over time chart
  - **7s** - Seven tracking and vulnerability stats
  - **Debug** - Raw data and recent rolls

## How It Works

The extension hooks into Colonist.io's React game state to:
1. Read the board layout (hex positions, dice numbers, resource types)
2. Track player building positions (settlements/cities)
3. Calculate expected resources per roll based on dice probabilities
4. Compare actual resources received to expected values

### Probability Calculation

For each hex adjacent to your buildings:
- P(dice = n) = (6 - |n - 7|) / 36
- Expected resources = Σ P(dice) × multiplier (1 for settlement, 2 for city)

### Percentile/Confidence

Uses z-score and normal CDF to calculate how statistically significant your luck is:
- Variance scales with √n (number of rolls)
- Confidence indicator (●●●) shows sample size reliability
- Early game percentiles are less meaningful (law of large numbers)

### Cities & Knights

The extension auto-detects C&K games and adjusts calculations:
- **City Production** - In C&K, cities on sheep/ore/wood hexes produce 1 resource + 1 commodity (instead of 2 resources)
- **Commodities** - Tracks cloth (from sheep), coin (from ore), and paper (from wood)
- **City Walls** - The 7s vulnerability tracking uses each player's actual discard limit (7 + city walls)

## Console API

Access raw data via browser console:
```javascript
PearsonRAE.getStats()     // All player statistics
PearsonRAE.getRolls()     // Dice roll history
PearsonRAE.getSevens()    // 7s analysis
PearsonRAE.toggle()       // Toggle collapsed state
PearsonRAE.isCK()         // Check if Cities & Knights game
```

## Files

- `manifest.json` - Chrome extension manifest (v3)
- `content.js` - Injects the tracker script
- `inject.js` - Main tracker logic
- `popup.html/js` - Extension popup UI
- `icon.svg/png` - Extension icon

## License

MIT
