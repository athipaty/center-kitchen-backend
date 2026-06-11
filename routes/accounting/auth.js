const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const Token   = require('../../models/shared/Token');

const TOKEN_DAYS = 30;

router.post('/login', async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== (process.env.PU_PASSWORD || '050231')) {
      return res.status(401).json({ message: 'Incorrect password' });
    }
    const token  = crypto.randomBytes(32).toString('hex');
    const expiry = Date.now() + TOKEN_DAYS * 24 * 60 * 60 * 1000;
    await Token.create({ token, ip: req.socket.remoteAddress, expiry });
    res.json({ token, expiry });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/verify', async (req, res) => {
  try {
    const { token } = req.body;
    const entry = await Token.findOne({ token });
    if (!entry)              return res.status(401).json({ valid: false });
    if (Date.now() > entry.expiry) {
      await Token.deleteOne({ token });
      return res.status(401).json({ valid: false });
    }
    res.json({ valid: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
