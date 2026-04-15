const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { db } = require('../database');

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/driver');
  res.render('login', { error: req.query.error || null });
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.getAsync('SELECT * FROM users WHERE username=? AND active=1', [username]);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.redirect('/login?error=Pogresno korisnicko ime ili lozinka');
    }
    req.session.user = { id: user.id, name: user.name, username: user.username, role: user.role };
    res.redirect(user.role === 'admin' ? '/admin' : '/driver');
  } catch(e) { res.redirect('/login?error=Greska pri najava'); }
});

router.post('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

module.exports = router;
