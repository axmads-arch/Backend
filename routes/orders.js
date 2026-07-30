const bot = require("./bot");
const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TELEGRAM_TOKEN = '8743223478:AAHuWX3CfWwfE8Vz7C8eHppkU2bcphZ2NEE';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const ADMIN_CHAT_ID = '-5192922233';

const STATUS_LABELS = {
  new: '🆕 Yangi', preparing: '👨‍🍳 Tayyorlanmoqda', ready: '✅ Tayyor',
  delivering: '🚗 Yetkazilmoqda', delivered: '🎉 Yetkazildi', cancelled: '❌ Bekor',
};
const PAYMENT_LABELS = { cash: '💵 Naqd', click: '📱 Click', payme: '💳 Payme', card: '💳 Karta' };
const DELIVERY_LABELS = { delivery: '🚗 Yetkazib berish', pickup: '🏃 Olib ketish' };

async function sendTelegram(text, extra = {}) {
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text, parse_mode: 'Markdown', ...extra }),
    });
  } catch (e) { console.log('Telegram xatolik:', e.message); }
}

async function sendPhoto(photoUrl, caption, extra = {}) {
  try {
    await fetch(`${TELEGRAM_API}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, photo: photoUrl, caption, parse_mode: 'Markdown', ...extra }),
    });
  } catch (e) { console.log('Telegram photo xatolik:', e.message); }
}

router.get('/', async (req, res) => {
  try {
    const { status, phone } = req.query;
    const where = {};
    if (status) where.status = status;
    if (phone) where.customerPhone = { contains: phone };
    const orders = await prisma.order.findMany({
      where, include: { items: { include: { product: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(orders);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/my/:phone', async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: { customerPhone: req.params.phone },
      include: { items: { include: { product: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(orders);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { customerPhone, customerName, deliveryType, paymentMethod, address, comment, latitude, longitude, items, scheduledTime } = req.body;
    if (!customerPhone || !items?.length) return res.status(400).json({ error: 'Telefon va mahsulotlar kerak' });

    await prisma.customer.upsert({
      where: { phone: customerPhone },
      update: { name: customerName, address },
      create: { phone: customerPhone, name: customerName, address },
    });

    const productIds = items.map(i => i.productId);
    const products = await prisma.product.findMany({ where: { id: { in: productIds } } });
    const productMap = Object.fromEntries(products.map(p => [p.id, p]));

    for (const item of items) {
      const product = productMap[item.productId];
      if (product && product.stock !== null && product.stock < item.quantity) {
        return res.status(400).json({ error: `${product.name} da yetarli stok yo'q (${product.stock} ta qoldi)` });
      }
    }

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    const deliveryPrice = deliveryType === 'delivery' ? (settings?.deliveryPrice || 0) : 0;

    let totalPrice = deliveryPrice;
    const orderItems = items.map(item => {
      const product = productMap[item.productId];
      const price = product ? product.price : item.price;
      totalPrice += price * item.quantity;
      return { productId: item.productId, quantity: item.quantity, price };
    });

    const order = await prisma.order.create({
      data: {
        customerPhone, customerName,
        deliveryType: deliveryType || 'delivery',
        paymentMethod: paymentMethod || 'click',
        address, comment, latitude, longitude,
        totalPrice, deliveryPrice,
        scheduledTime: scheduledTime ? new Date(scheduledTime) : null,
        items: { create: orderItems },
      },
      include: { items: { include: { product: true } } },
    });

    for (const item of items) {
      const product = productMap[item.productId];
      if (product && product.stock !== null) {
        const newStock = Math.max(0, product.stock - item.quantity);
        await prisma.product.update({
          where: { id: item.productId },
          data: { stock: newStock, available: newStock > 0 }
        });
      }
    }

    const itemsText = order.items.map(i =>
      `  • ${i.product?.name || 'Mahsulot'} x${i.quantity} — ${(i.price * i.quantity).toLocaleString()} so'm`
    ).join('\n');

    const locationText = latitude && longitude
      ? `\n📍 [Xarita](https://maps.google.com/?q=${latitude},${longitude})` : '';
    const scheduleText = scheduledTime
      ? `\n📅 *Vaqt: ${new Date(scheduledTime).toLocaleString('uz-UZ', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}*` : '';

    // Chek URL ni commentdan olish
    const checkMatch = comment && comment.match(/Chek: (https?:\/\/\S+)/);
    const checkUrl = checkMatch ? checkMatch[1] : null;
    const cleanComment = comment ? comment.replace(/\nChek: https?:\/\/\S+/, '').trim() : '';

    const msgText =
      `🛒 *Yangi buyurtma #${order.id}*\n\n` +
      `👤 ${customerName || "Noma'lum"}\n📞 ${customerPhone}\n` +
      `${DELIVERY_LABELS[deliveryType] || deliveryType}\n${PAYMENT_LABELS[paymentMethod] || paymentMethod}\n` +
      (address ? `🏠 ${address}` : '') + locationText + scheduleText +
      (cleanComment ? `\n💬 ${cleanComment}` : '') +
      `\n\n📦 *Mahsulotlar:*\n${itemsText}\n\n💰 *Jami: ${totalPrice.toLocaleString()} so'm*`;

    // Inline tugmalar — tasdiqlash/rad etish + Yandex Go
    const inlineButtons = [[
      { text: '✅ Tasdiqlash', callback_data: `confirm_${order.id}` },
      { text: '❌ Rad etish', callback_data: `cancel_${order.id}` },
    ]];

    // Yandex Go deep link — faqat manzil bo'lsa
    if (latitude && longitude) {
      const yandexGoUrl = `https://3.redirect.appmetrica.yandex.com/route?start-lat=41.3224858&start-lon=69.2091613&end-lat=${latitude}&end-lon=${longitude}&tariff=courier&appId=ru.yandex.taxi&adjusted_creative_id=5168406774`;
      inlineButtons.push([
        { text: '🚖 Yandex Go — Kuryer chaqirish', url: yandexGoUrl }
      ]);
    }

    const inlineKeyboard = { inline_keyboard: inlineButtons };

    if (checkUrl) {
      await sendPhoto(checkUrl, msgText, { reply_markup: inlineKeyboard });
    } else {
      await sendTelegram(msgText, { reply_markup: inlineKeyboard });
    }

    const io = req.app.get('io');
    if (io) io.emit('new_order', order);
    res.json(order);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Telegram callback — tasdiqlash/rad etish
router.post('/tg-callback', async (req, res) => {
  res.sendStatus(200);
  try {
    const { callback_query } = req.body;
    if (!callback_query) return;

    const data = callback_query.data;
    const chatId = callback_query.message.chat.id;
    const messageId = callback_query.message.message_id;

    const removeButtons = async () => {
      await fetch(`${TELEGRAM_API}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
      });
    };

    if (data.startsWith('confirm_')) {
      const orderId = Number(data.replace('confirm_', ''));
      const order = await prisma.order.update({
        where: { id: orderId }, data: { status: 'preparing' },
        include: { items: { include: { product: true } } },
      });
      await removeButtons();
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: `✅ *Buyurtma #${orderId} tasdiqlandi!*\n👨‍🍳 Tayyorlanmoqda...`, parse_mode: 'Markdown' }),
      });
      try { await bot.notifyCustomer(order.customerPhone, order.id, 'preparing', order.totalPrice, order.paymentMethod); } catch(e) {}

    } else if (data.startsWith('cancel_')) {
      const orderId = Number(data.replace('cancel_', ''));
      const order = await prisma.order.update({
        where: { id: orderId }, data: { status: 'cancelled' },
        include: { items: { include: { product: true } } },
      });
      for (const item of order.items) {
        const product = await prisma.product.findUnique({ where: { id: item.productId } });
        if (product && product.stock !== null) {
          await prisma.product.update({ where: { id: item.productId }, data: { stock: product.stock + item.quantity, available: true } });
        }
      }
      await removeButtons();
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: `❌ *Buyurtma #${orderId} rad etildi*`, parse_mode: 'Markdown' }),
      });
      try { await bot.notifyCustomer(order.customerPhone, order.id, 'cancelled', order.totalPrice, order.paymentMethod); } catch(e) {}
    }

    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callback_query.id }),
    });
  } catch (e) { console.log('Callback xatolik:', e.message); }
});

router.put('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const order = await prisma.order.update({
      where: { id: Number(req.params.id) }, data: { status },
      include: { items: { include: { product: true } } },
    });
    if (status === 'cancelled') {
      for (const item of order.items) {
        const product = await prisma.product.findUnique({ where: { id: item.productId } });
        if (product && product.stock !== null) {
          await prisma.product.update({ where: { id: item.productId }, data: { stock: product.stock + item.quantity, available: true } });
        }
      }
    }
    const io = req.app.get('io');
    if (io) io.emit('order_updated', { orderId: order.id, status });
    await sendTelegram(`📦 *Buyurtma #${order.id}* — ${STATUS_LABELS[status] || status}\n📞 ${order.customerPhone}`);
    try { await bot.notifyCustomer(order.customerPhone, order.id, status, order.totalPrice, order.paymentMethod); } catch(e) {}
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await prisma.orderItem.deleteMany({ where: { orderId: Number(req.params.id) } });
    await prisma.order.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
