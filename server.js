const express = require('express');
const session = require('express-session');
const path = require('path');
const { db, init } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
  secret: 'zitoLuks-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 12 * 60 * 60 * 1000 }
}));

app.use((req, res, next) => { res.locals.user = req.session.user || null; next(); });

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
  next();
}
function requireDriver(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role === 'admin') return res.redirect('/admin');
  next();
}

app.use('/', require('./routes/auth'));
app.use('/admin', requireAdmin, require('./routes/admin'));
app.use('/driver', requireDriver, require('./routes/driver'));

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/driver');
});

// Init DB then start server
init().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🍞 ZitoLuks работи на: http://localhost:${PORT}\n`);
  });
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
