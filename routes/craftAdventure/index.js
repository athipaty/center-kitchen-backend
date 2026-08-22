const express = require("express");
const router = express.Router();
const Player = require("../../models/craftAdventure/Player");

// ===========================
// CRAFTING RECIPES
// ===========================
const RECIPES = {
  axe: {
    upgradeKey: "axeLevel",
    maxLevel: 2,
    costs: {
      1: { wood: 5, stone: 3 },
      2: { wood: 12, ore: 6 },
    },
  },
  pickaxe: {
    upgradeKey: "pickaxeLevel",
    maxLevel: 2,
    costs: {
      1: { wood: 4, stone: 5 },
      2: { stone: 10, ore: 8 },
    },
  },
  boots: {
    upgradeKey: "bootsLevel",
    maxLevel: 2,
    costs: {
      1: { wood: 3, stone: 3 },
      2: { wood: 8, ore: 5 },
    },
  },
  bag: {
    upgradeKey: "bagLevel",
    maxLevel: 2,
    costs: {
      1: { wood: 6, stone: 6 },
      2: { stone: 10, ore: 10 },
    },
  },
  // Player equipment, not a placed unit — crafting it is what lets the
  // player fight at all (see the client's combat logic); level scales
  // attack damage.
  knight: {
    upgradeKey: "knightLevel",
    maxLevel: 2,
    costs: {
      1: { wood: 6, ore: 6 },
      2: { ore: 12, stone: 8 },
    },
  },
};

// ===========================
// BUILDABLE STRUCTURES
// ===========================
const STRUCTURES = {
  wall: {
    cost: { wood: 5 }, // level 1 (build cost)
    maxLevel: 3,
    upgradeCost: {
      2: { wood: 6, stone: 4 },
      3: { stone: 10, ore: 6 },
    },
  },
  // A defensive turret that auto-fires at enemies (client-side combat
  // logic) — no levels, just a build cost. Enemies never fight back, so
  // there's no health to track and nothing that could destroy it.
  tower: {
    cost: { wood: 8, stone: 10 },
  },
};

// Total resources sunk into a structure at a given level — its build cost
// plus every upgrade paid to reach that level. Demolish refunds this, not
// just the base build cost, so upgrading isn't a way to lose value.
function totalInvestedCost(type, level) {
  const def = STRUCTURES[type];
  if (!def) return {};
  const total = { ...def.cost };
  for (let lvl = 2; lvl <= level; lvl++) {
    const upgradeCost = def.upgradeCost?.[lvl] || {};
    for (const [resource, amount] of Object.entries(upgradeCost)) {
      total[resource] = (total[resource] || 0) + amount;
    }
  }
  return total;
}

// ===========================
// PLAYER (find-or-create by name — no password for v1)
// ===========================
router.get("/player/:name", async (req, res) => {
  try {
    const name = req.params.name.trim().slice(0, 20);
    if (!name) return res.status(400).json({ error: "Name is required" });

    let player = await Player.findOne({ name });
    if (!player) {
      player = await Player.create({ name });
    }
    res.json(player);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================
// SAVE (position + inventory, called periodically from the client)
// ===========================
router.post("/player/:name/save", async (req, res) => {
  try {
    const name = req.params.name.trim().slice(0, 20);
    const { x, y, inventory } = req.body;

    const update = {};
    if (typeof x === "number") update.x = x;
    if (typeof y === "number") update.y = y;
    if (inventory && typeof inventory === "object") {
      for (const key of ["wood", "stone", "ore"]) {
        if (typeof inventory[key] === "number") {
          update[`inventory.${key}`] = Math.max(0, Math.floor(inventory[key]));
        }
      }
    }

    const player = await Player.findOneAndUpdate({ name }, update, { new: true });
    if (!player) return res.status(404).json({ error: "Player not found" });
    res.json(player);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================
// CRAFT (validated server-side against RECIPES so the client can't
// grant itself upgrades by calling the API directly)
// ===========================
router.post("/player/:name/craft", async (req, res) => {
  try {
    const name = req.params.name.trim().slice(0, 20);
    const { item } = req.body;
    const recipe = RECIPES[item];
    if (!recipe) return res.status(400).json({ error: "Unknown item" });

    const player = await Player.findOne({ name });
    if (!player) return res.status(404).json({ error: "Player not found" });

    const currentLevel = player.upgrades[recipe.upgradeKey] || 0;
    const nextLevel = currentLevel + 1;
    if (nextLevel > recipe.maxLevel) {
      return res.status(400).json({ error: "Already at max level" });
    }

    const cost = recipe.costs[nextLevel];
    for (const [resource, amount] of Object.entries(cost)) {
      if ((player.inventory[resource] || 0) < amount) {
        return res.status(400).json({ error: `Not enough ${resource}` });
      }
    }

    for (const [resource, amount] of Object.entries(cost)) {
      player.inventory[resource] -= amount;
    }
    player.upgrades[recipe.upgradeKey] = nextLevel;

    await player.save();
    res.json(player);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================
// BUILD (place a structure — validated server-side like craft, so the
// client can't grant itself free structures by calling the API directly)
// ===========================
router.post("/player/:name/build", async (req, res) => {
  try {
    const name = req.params.name.trim().slice(0, 20);
    const { type, x, y } = req.body;
    const structure = STRUCTURES[type];
    if (!structure) return res.status(400).json({ error: "Unknown structure" });
    if (typeof x !== "number" || typeof y !== "number") {
      return res.status(400).json({ error: "Invalid position" });
    }

    const player = await Player.findOne({ name });
    if (!player) return res.status(404).json({ error: "Player not found" });

    for (const [resource, amount] of Object.entries(structure.cost)) {
      if ((player.inventory[resource] || 0) < amount) {
        return res.status(400).json({ error: `Not enough ${resource}` });
      }
    }

    for (const [resource, amount] of Object.entries(structure.cost)) {
      player.inventory[resource] -= amount;
    }
    player.structures.push({ type, x, y });

    await player.save();
    res.json(player);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================
// DEMOLISH (remove a placed structure and refund everything invested in it,
// including any upgrades)
// ===========================
router.post("/player/:name/demolish", async (req, res) => {
  try {
    const name = req.params.name.trim().slice(0, 20);
    const { structureId } = req.body;

    const player = await Player.findOne({ name });
    if (!player) return res.status(404).json({ error: "Player not found" });

    const target = player.structures.id(structureId);
    if (!target) return res.status(404).json({ error: "Structure not found" });

    const cost = totalInvestedCost(target.type, target.level || 1);
    for (const [resource, amount] of Object.entries(cost)) {
      player.inventory[resource] = (player.inventory[resource] || 0) + amount;
    }
    target.deleteOne();

    await player.save();
    res.json(player);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================
// MOVE STRUCTURE (relocate a placed structure — free, keeps its level)
// ===========================
router.post("/player/:name/move-structure", async (req, res) => {
  try {
    const name = req.params.name.trim().slice(0, 20);
    const { structureId, x, y } = req.body;
    if (typeof x !== "number" || typeof y !== "number") {
      return res.status(400).json({ error: "Invalid position" });
    }

    const player = await Player.findOne({ name });
    if (!player) return res.status(404).json({ error: "Player not found" });

    const target = player.structures.id(structureId);
    if (!target) return res.status(404).json({ error: "Structure not found" });

    target.x = x;
    target.y = y;

    await player.save();
    res.json(player);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================
// UPGRADE STRUCTURE (validated server-side like craft/build, so the client
// can't grant itself levels by calling the API directly)
// ===========================
router.post("/player/:name/upgrade-structure", async (req, res) => {
  try {
    const name = req.params.name.trim().slice(0, 20);
    const { structureId } = req.body;

    const player = await Player.findOne({ name });
    if (!player) return res.status(404).json({ error: "Player not found" });

    const target = player.structures.id(structureId);
    if (!target) return res.status(404).json({ error: "Structure not found" });

    const def = STRUCTURES[target.type];
    const currentLevel = target.level || 1;
    const nextLevel = currentLevel + 1;
    if (!def || nextLevel > (def.maxLevel || 1)) {
      return res.status(400).json({ error: "Already at max level" });
    }

    const cost = def.upgradeCost[nextLevel];
    for (const [resource, amount] of Object.entries(cost)) {
      if ((player.inventory[resource] || 0) < amount) {
        return res.status(400).json({ error: `Not enough ${resource}` });
      }
    }

    for (const [resource, amount] of Object.entries(cost)) {
      player.inventory[resource] -= amount;
    }
    target.level = nextLevel;

    await player.save();
    res.json(player);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================
// RESET (testing only — wipes this player's progress back to defaults)
// ===========================
router.post("/player/:name/reset", async (req, res) => {
  try {
    const name = req.params.name.trim().slice(0, 20);

    const player = await Player.findOneAndUpdate(
      { name },
      {
        x: 1200, // center of the world (WORLD_W x WORLD_H = 2400 x 1600 in game.js)
        y: 800,
        inventory: { wood: 0, stone: 0, ore: 0 },
        upgrades: { axeLevel: 0, pickaxeLevel: 0, bootsLevel: 0, bagLevel: 0, knightLevel: 0 },
        structures: [],
      },
      { new: true }
    );
    if (!player) return res.status(404).json({ error: "Player not found" });
    res.json(player);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
