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
};

// ===========================
// BUILDABLE STRUCTURES
// ===========================
const STRUCTURES = {
  wall: {
    cost: { wood: 5 },
  },
};

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
// DEMOLISH (remove a placed structure and refund its full cost)
// ===========================
router.post("/player/:name/demolish", async (req, res) => {
  try {
    const name = req.params.name.trim().slice(0, 20);
    const { structureId } = req.body;

    const player = await Player.findOne({ name });
    if (!player) return res.status(404).json({ error: "Player not found" });

    const target = player.structures.id(structureId);
    if (!target) return res.status(404).json({ error: "Structure not found" });

    const cost = STRUCTURES[target.type]?.cost || {};
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
        upgrades: { axeLevel: 0, pickaxeLevel: 0, bootsLevel: 0, bagLevel: 0 },
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
