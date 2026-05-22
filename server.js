const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── STOCK (à remplacer par une base de données plus tard) ───────────────────
const stock = { grain: 10, moulu: 10 };

// ─── PRIX ────────────────────────────────────────────────────────────────────
const PRIX = { grain: 5500, moulu: 4500 }; // en centimes

// ─── FRAIS DE PORT COLISSIMO 2026 ────────────────────────────────────────────
// Poids estimé par sachet : ~650g (500g café + emballage)
function calcPort(totalQty, zone) {
  const poids = totalQty * 0.65; // kg

  const grilles = {
    fr: [
      { max: 0.5,  prix: 759  },
      { max: 0.75, prix: 929  },
      { max: 1,    prix: 959  },
      { max: 2,    prix: 1119 },
      { max: 5,    prix: 1739 },
      { max: 10,   prix: 2529 },
      { max: 999,  prix: 3959 },
    ],
    eu: [
      { max: 0.5,  prix: 1190 },
      { max: 1,    prix: 1490 },
      { max: 2,    prix: 1990 },
      { max: 5,    prix: 3200 },
      { max: 999,  prix: 4800 },
    ],
    world: [
      { max: 0.5,  prix: 3350 },
      { max: 1,    prix: 4000 },
      { max: 2,    prix: 5500 },
      { max: 5,    prix: 8000 },
      { max: 999,  prix: 12000 },
    ],
  };

  const grille = grilles[zone] || grilles.fr;
  for (const tranche of grille) {
    if (poids <= tranche.max) return tranche.prix;
  }
  return grille[grille.length - 1].prix;
}

// ─── ROUTE : VÉRIFICATION DU STOCK ───────────────────────────────────────────
app.get('/stock', (req, res) => {
  res.json(stock);
});

// ─── ROUTE : CRÉATION SESSION STRIPE CHECKOUT ────────────────────────────────
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { qtyGrain = 0, qtyMoulu = 0, zone = 'fr' } = req.body;
    const totalQty = qtyGrain + qtyMoulu;

    // Validation
    if (totalQty === 0) {
      return res.status(400).json({ error: 'Aucun produit sélectionné.' });
    }
    if (!['fr', 'eu', 'world'].includes(zone)) {
      return res.status(400).json({ error: 'Zone de livraison invalide.' });
    }

    // Vérification stock
    if (qtyGrain > stock.grain) {
      return res.status(400).json({ error: `Stock insuffisant pour le café en grain (${stock.grain} disponibles).` });
    }
    if (qtyMoulu > stock.moulu) {
      return res.status(400).json({ error: `Stock insuffisant pour le café moulu (${stock.moulu} disponibles).` });
    }

    // Construction des lignes de commande
    const lineItems = [];

    if (qtyGrain > 0) {
      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'Burundi Kayanza — Café en grain 500g',
            description: 'Café de spécialité, origine Kayanza, Burundi. Récolte 2024.',
          },
          unit_amount: PRIX.grain,
        },
        quantity: qtyGrain,
      });
    }

    if (qtyMoulu > 0) {
      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'Burundi Kayanza — Café moulu 500g',
            description: 'Café de spécialité moulu, origine Kayanza, Burundi. Récolte 2024.',
          },
          unit_amount: PRIX.moulu,
        },
        quantity: qtyMoulu,
      });
    }

    // Frais de port
    const portCentimes = calcPort(totalQty, zone);
    const zoneLabel = { fr: 'France métropolitaine', eu: 'Europe', world: 'International' }[zone];
    lineItems.push({
      price_data: {
        currency: 'eur',
        product_data: {
          name: `Livraison Colissimo — ${zoneLabel}`,
          description: 'Livraison avec suivi, délai 48h-5 jours selon destination.',
        },
        unit_amount: portCentimes,
      },
      quantity: 1,
    });

    // Pays autorisés selon la zone
    const paysByZone = {
      fr: ['FR'],
      eu: ['FR', 'BE', 'CH', 'LU', 'DE', 'ES', 'IT', 'NL', 'PT', 'AT', 'PL', 'SE', 'DK', 'FI', 'IE', 'GR'],
      world: ['FR', 'BE', 'CH', 'LU', 'DE', 'ES', 'IT', 'NL', 'PT', 'US', 'CA', 'AU', 'JP', 'GB'],
    };

    // Création de la session Stripe
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${process.env.SITE_URL || 'http://localhost:3000'}/merci.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL || 'http://localhost:3000'}/`,
      billing_address_collection: 'required',
      shipping_address_collection: {
        allowed_countries: paysByZone[zone],
      },
      metadata: {
        qty_grain: qtyGrain,
        qty_moulu: qtyMoulu,
        zone: zone,
      },
      locale: 'fr',
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error('Erreur Stripe:', err.message);
    res.status(500).json({ error: 'Erreur lors de la création de la session de paiement.' });
  }
});

// ─── WEBHOOK STRIPE (mise à jour du stock après paiement confirmé) ─────────────
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature invalide:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const qtyGrain = parseInt(session.metadata.qty_grain || 0);
    const qtyMoulu = parseInt(session.metadata.qty_moulu || 0);

    // Décrémenter le stock
    stock.grain = Math.max(0, stock.grain - qtyGrain);
    stock.moulu = Math.max(0, stock.moulu - qtyMoulu);

    console.log(`✅ Commande confirmée — Grain: -${qtyGrain} (reste: ${stock.grain}) | Moulu: -${qtyMoulu} (reste: ${stock.moulu})`);
  }

  res.json({ received: true });
});

// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Serveur Burundi Coffee démarré sur le port ${PORT}`);
  console.log(`   Mode: ${process.env.NODE_ENV || 'développement'}`);
  console.log(`   Stripe: ${process.env.STRIPE_SECRET_KEY ? '🔐 clé configurée' : '⚠️  STRIPE_SECRET_KEY manquante'}`);
});
