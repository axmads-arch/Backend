const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TELEGRAM_TOKEN = '8743223478:AAHuWX3CfWwfE8Vz7C8eHppkU2bcphZ2NEE';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const ADMIN_CHAT_ID = '-5192922233';
const SITE_URL = 'https://frontend-topaz-kappa-84.vercel.app';
const PHONE = '+998 93 272 2222';
const ADDRESS = "Ko'kcha darvoza 340a";
const LATITUDE = 41.3224858;
const LONGITUDE = 69.2091613;
const INSTAGRAM = 'https://www.instagram.com/rahmatchef.uz';

const waitingFeedback = new Set();
// Admin narx kiritishni kutmoqda: orderId saqlash
const waitingDeliveryPrice = new Map(); // chatId -> orderId

async function sendMessage(chatId, text, extra = {}) {
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', ...extra }),
    });
  } catch (e) { console.log('sendMessage xatolik:', e.message); }
}

async function sendLocation(chatId, lat, lon) {
  try {
    await fetch(`${TELEGRAM_API}/sendLocation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, latitude: lat, longitude: lon }),
    });
  } catch (e) {}
}

async function notifyCustomer(customerPhone, orderId, status, total, paymentMethod, deliveryPrice) {
  try {
    const customer = await prisma.customer.findUnique({ where: { phone: customerPhone } });
    if (!customer?.telegramChatId) return;
    const STATUS = {
      new: '🆕 Buyurtmangiz qabul qilindi',
      preparing: '👨‍🍳 Buyurtmangiz tayyorlanmoqda',
      ready: '✅ Buyurtmangiz tayyor!',
      delivering: '🚗 Buyurtmangiz yetkazilmoqda',
      delivered: '🎉 Buyurtmangiz yetkazildi!\n\nRahmat, yana keling! 🍰',
      cancelled: '❌ Buyurtmangiz bekor qilindi',
    };
    const PAY = { cash: 'Naqd', click: 'Click', payme: 'Payme', card: 'Karta' };
    const msg = STATUS[status];
    if (!msg) return;
    const payLabel = PAY[paymentMethod] || 'Click';

    let text = `${msg}\n\n📦 Buyurtma #${orderId}\n💳 ${payLabel}: ${total ? total.toLocaleString() + " so'm ✅" : ''}`;

    // Yetkazish narxi qo'shish
    if (deliveryPrice && status === 'preparing') {
      text += `\n\n🚗 Yetkazib berish: *${Number(deliveryPrice).toLocaleString()} so'm*\n💵 Kuryer kelganda naqd to'lang`;
    }

    await sendMessage(customer.telegramChatId, text);
  } catch (e) { console.log('notifyCustomer xatolik:', e.message); }
}

const MAIN_MENU = {
  keyboard: [
    [{ text: '🛒 Buyurtma berish' }],
    [{ text: '📍 Bizning manzil' }, { text: 'ℹ️ Biz haqimizda' }],
    [{ text: '💬 Izoh qoldirish' }, { text: '📞 Raqamni yuborish' }],
  ],
  resize_keyboard: true,
};

const CONTACT_BUTTON = {
  keyboard: [
    [{ text: '📞 Raqamimni yuborish', request_contact: true }],
    [{ text: '⬅️ Orqaga' }],
  ],
  resize_keyboard: true,
};

const BACK_MENU = {
  keyboard: [[{ text: '⬅️ Orqaga' }]],
  resize_keyboard: true,
};

router.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const update = req.body;

    // ── CALLBACK QUERY ──
    if (update.callback_query) {
      const cq = update.callback_query;
      const data = cq.data;
      const chatId = cq.message.chat.id;
      const messageId = cq.message.message_id;

      const removeButtons = async () => {
        try {
          await fetch(`${TELEGRAM_API}/editMessageReplyMarkup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
          });
        } catch(e) {}
      };

      await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cq.id }),
      });

      if (data.startsWith('confirm_')) {
        const orderId = Number(data.replace('confirm_', ''));
        try {
          await removeButtons();
          // Admin dan yetkazish narxini so'rash
          waitingDeliveryPrice.set(String(chatId), orderId);
          await sendMessage(chatId,
            `✅ *Buyurtma #${orderId}* tasdiqlandi!\n\n🚗 Yetkazib berish narxini kiriting (so'mda):\nMasalan: \`15000\`\n\nYoki /skip yozing — narxsiz tasdiqlash`,
            { reply_markup: { keyboard: [[{ text: '/skip' }]], resize_keyboard: true } }
          );
        } catch(e) { console.log('Confirm xatolik:', e.message); }

      } else if (data.startsWith('cancel_')) {
        const orderId = Number(data.replace('cancel_', ''));
        try {
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
          await sendMessage(ADMIN_CHAT_ID, `❌ *Buyurtma #${orderId} rad etildi*`);
          await notifyCustomer(order.customerPhone, order.id, 'cancelled', order.totalPrice, order.paymentMethod);
        } catch(e) { console.log('Cancel xatolik:', e.message); }
      }
      return;
    }

    // ── CONTACT ──
    if (update.message?.contact) {
      const chatId = update.message.chat.id;
      const contact = update.message.contact;
      const from = update.message.from;
      let phone = contact.phone_number;
      if (!phone.startsWith('+')) phone = '+' + phone;
      try {
        await prisma.customer.upsert({
          where: { phone },
          update: { telegramChatId: String(chatId) },
          create: { phone, telegramChatId: String(chatId) },
        });
      } catch (e) { console.log('DB xatolik:', e.message); }
      await sendMessage(chatId,
        `✅ Rahmat! Raqamingiz bog'landi:\n📞 ${phone}\n\nEndi buyurtma berib, holati haqida xabar olasiz! 🎉`,
        { reply_markup: MAIN_MENU }
      );
      await sendMessage(ADMIN_CHAT_ID,
        `📞 *Yangi raqam yuborildi*\n\n👤 ${from.first_name || ''} ${from.last_name || ''}\n📱 ${phone}`
      );
      return;
    }

    const message = update.message;
    if (!message?.text) return;

    const chatId = message.chat.id;
    const text = message.text.trim();
    const userId = message.from.id;

    // ── YETKAZISH NARXI KIRITISH ──
    if (waitingDeliveryPrice.has(String(chatId))) {
      const orderId = waitingDeliveryPrice.get(String(chatId));

      if (text === '/skip') {
        // Narxsiz tasdiqlash
        waitingDeliveryPrice.delete(String(chatId));
        try {
          const order = await prisma.order.update({
            where: { id: orderId }, data: { status: 'preparing' },
            include: { items: true },
          });
          await sendMessage(ADMIN_CHAT_ID, `👨‍🍳 Buyurtma #${orderId} tayyorlanmoqda...`, { reply_markup: MAIN_MENU });
          await notifyCustomer(order.customerPhone, order.id, 'preparing', order.totalPrice, order.paymentMethod, null);
        } catch(e) {}
        return;
      }

      const price = parseInt(text.replace(/\s/g, ''));
      if (!isNaN(price) && price > 0) {
        waitingDeliveryPrice.delete(String(chatId));
        try {
          const order = await prisma.order.update({
            where: { id: orderId }, data: { status: 'preparing' },
            include: { items: { include: { product: true } } },
          });
          const totalWithDelivery = order.totalPrice + price;
          await sendMessage(ADMIN_CHAT_ID,
            `👨‍🍳 *Buyurtma #${orderId} tayyorlanmoqda*\n\n` +
            `💰 Mahsulot: ${order.totalPrice.toLocaleString()} so'm\n` +
            `🚗 Yetkazish: ${price.toLocaleString()} so'm\n` +
            `━━━━━━━━━━\n` +
            `📦 Jami: ${totalWithDelivery.toLocaleString()} so'm`,
            { reply_markup: MAIN_MENU }
          );
          // Mijozga to'liq ma'lumot yuborish
          await notifyCustomer(order.customerPhone, order.id, 'preparing', order.totalPrice, order.paymentMethod, price);
        } catch(e) { console.log('Narx xatolik:', e.message); }
        return;
      } else {
        await sendMessage(chatId, `⚠️ Faqat raqam kiriting!\nMasalan: \`15000\``);
        return;
      }
    }

    // ── ASOSIY TUGMALAR ──
    if (text === '/start' || text === '/menu') {
      waitingFeedback.delete(userId);
      await sendMessage(chatId,
        `👋 *Rahmat Chef*ga xush kelibsiz!\n\n🍰 Premium shirinliklar va ☕️ ichimliklar\n\n📱 Buyurtma holatini bilish uchun raqamingizni ulashing:`,
        { reply_markup: CONTACT_BUTTON }
      );
      return;
    }
    if (text === '⬅️ Orqaga') {
      waitingFeedback.delete(userId);
      await sendMessage(chatId, '🏠 Bosh menyu', { reply_markup: MAIN_MENU });
      return;
    }
    if (waitingFeedback.has(userId)) {
      waitingFeedback.delete(userId);
      await sendMessage(chatId, `✅ Rahmat! Izohingiz qabul qilindi. 🙏`, { reply_markup: MAIN_MENU });
      const from = message.from;
      await sendMessage(ADMIN_CHAT_ID,
        `💬 *Yangi izoh*\n\n👤 ${from.first_name || ''} ${from.last_name || ''}\n\n📝 *Matn:*\n${text}`
      );
      return;
    }
    if (text === '🛒 Buyurtma berish') {
      await sendMessage(chatId, `🛒 *Buyurtma berish*\n\nSaytimizga o'ting:\n\n🔗 ${SITE_URL}`, { reply_markup: MAIN_MENU });
      return;
    }
    if (text === '📍 Bizning manzil') {
      await sendMessage(chatId, `📍 *Bizning manzilimiz:*\n\n${ADDRESS}\n\n🕒 24/7 ochiq`, { reply_markup: MAIN_MENU });
      await sendLocation(chatId, LATITUDE, LONGITUDE);
      return;
    }
    if (text === 'ℹ️ Biz haqimizda') {
      await sendMessage(chatId,
        `ℹ️ *Rahmat Chef*\n\n🍰 Premium shirinliklar\n\n🕒 24/7\n📞 ${PHONE}\n📌 [Instagram](${INSTAGRAM})`,
        { reply_markup: MAIN_MENU }
      );
      return;
    }
    if (text === '💬 Izoh qoldirish') {
      waitingFeedback.add(userId);
      await sendMessage(chatId, `💬 Fikr yoki taklifingizni yozing:`, { reply_markup: BACK_MENU });
      return;
    }
    if (text === '📞 Raqamni yuborish') {
      await sendMessage(chatId, `📞 Raqamingizni ulashing:`, { reply_markup: CONTACT_BUTTON });
      return;
    }
    await sendMessage(chatId, `Quyidagi tugmalardan birini tanlang 👇`, { reply_markup: MAIN_MENU });

  } catch (e) { console.log('Bot xatolik:', e.message); }
});

router.get('/set-webhook', async (req, res) => {
  try {
    const webhookUrl = 'https://claude-production-0b03.up.railway.app/api/bot/webhook';
    const r = await fetch(`${TELEGRAM_API}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        drop_pending_updates: true,
        allowed_updates: ['message', 'callback_query'],
      }),
    });
    await fetch(`${TELEGRAM_API}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'start', description: 'Botni ishga tushirish' },
          { command: 'menu', description: 'Bosh menyu' },
        ],
      }),
    });
    res.json({ webhookUrl, result: await r.json() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/webhook-info', async (req, res) => {
  try {
    res.json(await (await fetch(`${TELEGRAM_API}/getWebhookInfo`)).json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.notifyCustomer = notifyCustomer;
