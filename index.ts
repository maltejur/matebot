import { Context, deunionize, Markup, Telegraf } from "telegraf";
import * as dotenv from "dotenv";
import packagejson from "./package.json";
import { PrismaClient } from "@prisma/client";
import { CallbackData } from "telegraf-callback-data";
import type { Update } from "telegraf/typings/core/types/typegram";
dotenv.config();

const prisma = new PrismaClient();

if (!process.env.BOT_TOKEN) throw new Error("No bot token");
const bot = new Telegraf(process.env.BOT_TOKEN);
const newUserRequestCallback = new CallbackData("newUserRequest", []);
const addNewUserCallback = new CallbackData<{ id: string }>("addNewUser", [
  "id",
]);
const blockUserCallback = new CallbackData<{ id: string }>("blockUser", ["id"]);
const historyCallback = new CallbackData<{ page: string; username: string }>(
  "history",
  ["page", "username"]
);

async function checkUser(ctx: Context<Update>) {
  const id = ctx.from.id.toString();
  const user = await prisma.user.findUnique({
    where: { id },
  });
  if ((user && !user.username) || user.username !== ctx.from.username) {
    await prisma.user.update({
      where: { id },
      data: { username: ctx.from.username },
    });
  }
  const allowed = !!user && user.enabled;
  if (!allowed)
    if (user && user.blocked) {
      await ctx.replyWithHTML("Du wurdest blockiert");
    } else {
      await ctx.replyWithHTML(
        "Du bist nicht freigeschaltet",
        Markup.inlineKeyboard([
          Markup.button.callback(
            "Freischaltung anfragen",
            newUserRequestCallback.create({})
          ),
        ])
      );
    }
  return allowed;
}

async function checkAdmin(ctx: Context<Update>) {
  const id = ctx.from.id.toString();
  const user = await prisma.user.findUnique({
    where: { id },
  });
  if (!user.username) {
    await prisma.user.update({
      where: { id },
      data: { username: ctx.from.username },
    });
  }
  const allowed = user && user.admin;
  if (!allowed) ctx.replyWithHTML("Du bist kein Admin");
  return allowed;
}

function inlineKeyboard() {
  return Markup.keyboard([
    [Markup.button.text("/drink")],
    [Markup.button.text("/check"), Markup.button.text("/return")],
  ]);
}

async function checkMate(ctx: Context<Update>) {
  const user = await prisma.user.findUnique({
    where: { id: ctx.from.id.toString() },
  });
  let message: string;
  if (user.admin) {
    const total = await prisma.total.findUnique({ where: { id: 0 } });
    const used = await prisma.user.aggregate({
      _sum: {
        value: true,
      },
    });
    message = `Mate auf Lager: <code>${total.value}</code>
Mate noch nicht Verteilt: <code>${total.value - used._sum.value}</code>
Persönlich verfügbare Mate: <code>${user.value}</code>`;
    if (user.pfand)
      message += `
Persönlich ausstehendes Pfand: <code>${user.pfand}</code>`;
  } else {
    message = `Mate Verfügbar: <code>${user.value}</code>`;
    if (user.pfand)
      message += `
Ausstehendes Pfand: <code>${user.pfand}</code>`;
  }
  await ctx.replyWithHTML(message, inlineKeyboard());
}

bot.start(async (ctx) => {
  await ctx.replyWithHTML(
    `<b>MateBot</b> v${packagejson.version}\n/help für Hilfe`
  );
  if (!(await checkUser(ctx))) return;
  await checkMate(ctx);
});

bot.action(newUserRequestCallback.filter(), async (ctx) => {
  const id = ctx.from.id.toString();
  const username = ctx.from.username;
  const existingUser = await prisma.user.findUnique({ where: { id } });
  if (existingUser && existingUser.enabled) {
    await ctx.answerCbQuery("Bereits aktiviert");
    return;
  }
  if (!username) {
    await ctx.answerCbQuery("Du hast keinen Telegram username");
    return;
  }
  if (!existingUser) {
    await prisma.user.create({ data: { id, username } });
  }
  const admins = await prisma.user.findMany({ where: { admin: true } });
  admins.forEach((admin) => {
    bot.telegram.sendMessage(
      admin.id,
      `@${username} hat sich registriert`,
      Markup.inlineKeyboard([
        Markup.button.callback("Annehmen", addNewUserCallback.create({ id })),
        Markup.button.callback("Ablehnen", blockUserCallback.create({ id })),
      ])
    );
  });
  ctx.answerCbQuery("Anfrage gesendet");
});

bot.action(addNewUserCallback.filter(), async (ctx) => {
  const { id } = addNewUserCallback.parse(deunionize(ctx.callbackQuery).data);
  if (!checkAdmin(ctx)) return;
  const user = await prisma.user.update({
    where: { id },
    data: { enabled: true, blocked: false },
  });
  await bot.telegram.sendMessage(
    id,
    `Du wurdest durch @${ctx.from.username} aktiviert. Dein Matestand beträgt: ${user.value}`,
    inlineKeyboard()
  );

  await ctx.answerCbQuery();
  const admins = await prisma.user.findMany({ where: { admin: true } });
  admins.forEach((admin) => {
    bot.telegram.sendMessage(admin.id, `@${user.username} wurde aktiviert`);
  });
});

bot.action(blockUserCallback.filter(), async (ctx) => {
  const { id } = blockUserCallback.parse(deunionize(ctx.callbackQuery).data);
  if (!checkAdmin(ctx)) return;
  const user = await prisma.user.update({
    where: { id },
    data: { enabled: false, blocked: true },
  });

  await ctx.answerCbQuery();
  const admins = await prisma.user.findMany({ where: { admin: true } });
  admins.forEach((admin) => {
    bot.telegram.sendMessage(admin.id, `@${user.username} wurde blockiert`);
  });
});

bot.command("id", (ctx) => {
  ctx.replyWithMarkdown(`User ID: \`${ctx.from.id}\`
Chat ID: \`${ctx.chat.id}\``);
});

bot.command("check", async (ctx) => {
  if (!(await checkUser(ctx))) return;
  await checkMate(ctx);
});

bot.command("drink", async (ctx) => {
  if (!(await checkUser(ctx))) return;
  const id = ctx.from.id.toString();
  const user = await prisma.user.findUnique({
    where: { id },
  });
  await prisma.user.update({
    where: { id },
    data: { value: user.value - 1, pfand: user.pfand + 1 },
  });
  await prisma.transactions.create({
    data: { userId: id, authorId: id, change: -1 },
  });
  await prisma.transactions.create({
    data: { userId: id, authorId: id, change: 1, type: "pfand" },
  });
  await prisma.transactions.create({
    data: {
      authorId: ctx.from.id.toString(),
      change: -1,
      type: "total",
    },
  });
  const total = await prisma.total.findUnique({ where: { id: 0 } });
  await prisma.total.update({
    where: { id: 0 },
    data: { value: total.value - 1 },
  });
  await ctx.reply(`Mate getrunken`);
  await checkMate(ctx);
});

bot.command("return", async (ctx) => {
  if (!(await checkUser(ctx))) return;
  const id = ctx.from.id.toString();
  const user = await prisma.user.findUnique({
    where: { id },
  });
  let amount = 1;
  if (ctx.message.text.split(" ").length > 1) {
    const parsedAmount = parseInt(ctx.message.text.split(" ")[1]);
    if (isNaN(parsedAmount)) {
      await ctx.replyWithHTML(
        `<code>${ctx.message.text.split(" ")[1]}</code> ist keine Zahl du kek`
      );
      return;
    }
    amount = parsedAmount;
  }

  if (amount > user.pfand) {
    await ctx.reply(
      amount === 1 ? `Kein Pfand ausstehend` : `Nicht so viel Pfand ausstehend`
    );
    await checkMate(ctx);
    return;
  }
  await prisma.user.update({
    where: { id },
    data: { pfand: user.pfand - amount },
  });
  await prisma.transactions.create({
    data: { userId: id, authorId: id, change: -amount, type: "pfand" },
  });
  await ctx.reply(
    `${amount === 1 ? "Eine" : amount} ${
      amount === 1 ? "Flasche" : "Flaschen"
    } zurückgegeben`
  );
  await checkMate(ctx);
});

bot.command("update", async (ctx) => {
  if (!(await checkAdmin(ctx))) return;
  try {
    const args = ctx.message.text.split(" ");
    if (args.length !== 3) throw new Error();
    if (args[1][0] !== "@") throw new Error();
    const username = args[1].substr(1);
    const user = await prisma.user.findUnique({ where: { username } });
    const newValue =
      args[2][0] === "+"
        ? user.value + Number.parseInt(args[2].substr(1))
        : args[2][0] === "-"
        ? user.value - Number.parseInt(args[2].substr(1))
        : Number.parseInt(args[2]);
    const change = newValue - user.value;
    await prisma.user.update({
      where: { username },
      data: { value: newValue },
    });
    await prisma.transactions.create({
      data: {
        userId: user.id,
        authorId: ctx.from.id.toString(),
        change,
      },
    });
    const total = await prisma.total.findUnique({ where: { id: 0 } });
    await bot.telegram.sendMessage(
      user.id,
      `Dein Matestand wurde von @${ctx.from.username} aktualisiert, neuer Stand: ${newValue}`
    );
    await ctx.replyWithHTML(
      `Matestand von @${username} aktualisiert, neuer Stand: <code>${newValue}</code>`
    );
  } catch (e) {
    await ctx.replyWithHTML(
      `Fehler, Benutzung: <code>/update @[username] ["+","-",""][Wert]</code>`
    );
    console.log(e);
    return;
  }
});

bot.command("updatep", async (ctx) => {
  if (!(await checkAdmin(ctx))) return;
  try {
    const args = ctx.message.text.split(" ");
    if (args.length !== 3) throw new Error();
    if (args[1][0] !== "@") throw new Error();
    const username = args[1].substr(1);
    const user = await prisma.user.findUnique({ where: { username } });
    const newPfand =
      args[2][0] === "+"
        ? user.pfand + Number.parseInt(args[2].substr(1))
        : args[2][0] === "-"
        ? user.pfand - Number.parseInt(args[2].substr(1))
        : Number.parseInt(args[2]);
    const change = newPfand - user.pfand;
    if (newPfand <= 0) {
      await ctx.reply("Pfand darf nicht unter 0 liegen");
      return;
    }
    await prisma.user.update({
      where: { username },
      data: { pfand: newPfand },
    });
    await prisma.transactions.create({
      data: {
        userId: user.id,
        authorId: ctx.from.id.toString(),
        change,
        type: "pfand",
      },
    });
    await bot.telegram.sendMessage(
      user.id,
      `Dein ausstehender Pfand wurde von @${ctx.from.username} aktualisiert, neuer Stand: ${newPfand}`
    );
    await ctx.replyWithHTML(
      `Ausstehender Pfand von @${username} aktualisiert, neuer Stand: <code>${newPfand}</code>`
    );
  } catch (e) {
    await ctx.replyWithHTML(
      `Fehler, Benutzung: <code>/updatep @[username] ["+","-",""][Wert]</code>`
    );
    console.log(e);
    return;
  }
});

bot.command("updatetotal", async (ctx) => {
  if (!(await checkAdmin(ctx))) return;
  try {
    const args = ctx.message.text.split(" ");
    if (args.length !== 2) throw new Error();
    const total = await prisma.total.findUnique({ where: { id: 0 } });
    const newValue =
      args[1][0] === "+"
        ? total.value + Number.parseInt(args[1].substr(1))
        : args[1][0] === "-"
        ? total.value - Number.parseInt(args[1].substr(1))
        : Number.parseInt(args[1]);
    const change = newValue - total.value;
    await prisma.total.update({
      where: { id: 0 },
      data: {
        value: newValue,
      },
    });
    await prisma.transactions.create({
      data: {
        authorId: ctx.from.id.toString(),
        change,
        type: "total",
      },
    });
    await ctx.replyWithHTML(
      `Totalstand wurde um <code>${change}</code> aktualisiert, neuer Stand: <code>${newValue}</code>`
    );
  } catch (e) {
    await ctx.replyWithHTML(
      `Fehler, Benutzung: <code>/updatetotal ["+","-",""][Wert]</code>`
    );
    console.log(e);
    return;
  }
});

bot.command("history", async (ctx) => {
  if (ctx.message.text === "/history all") {
    history(ctx);
  } else {
    let username = ctx.message.text
      .split(" ")
      .find((arg) => arg.startsWith("@"))
      ?.substr(1);
    if (username) {
      if (!(await checkAdmin(ctx))) return;
    } else username = ctx.from.username;
    history(ctx, username);
  }
});

bot.action(historyCallback.filter(), async (ctx) => {
  if (!(await checkUser(ctx))) return;
  const { page, username } = historyCallback.parse(
    deunionize(ctx.callbackQuery).data
  );
  await history(ctx, username, Number.parseInt(page));
  await ctx.answerCbQuery();
});

async function history(ctx: Context, username?: string, page?: number) {
  const PER_PAGE = 10;
  const transactions = await prisma.transactions.findMany({
    where: username ? { user: { username } } : {},
    include: { user: true, author: true },
    orderBy: {
      date: "asc",
    },
  });
  const numberPages = Math.ceil(transactions.length / PER_PAGE);
  if (page === undefined) page = numberPages - 1;
  ctx.replyWithHTML(
    `${
      username
        ? `<b>Verlauf</b> für @${username}, Seite ${page + 1}/${numberPages}`
        : `<b>Gesamtverlauf</b> Seite ${page + 1}/${numberPages}`
    }
${
  transactions
    .slice(PER_PAGE * page, PER_PAGE * (page + 1))
    .map(
      (transaction) =>
        `${transaction.date.toLocaleDateString()} ${transaction.date.toLocaleTimeString()} ${
          username
            ? ""
            : transaction.type === "total"
            ? "für Gesamt "
            : `für @${transaction.user.username} `
        }von @${transaction.author.username} ${
          transaction.change >= 0
            ? `+${transaction.change}`
            : transaction.change
        } ${transaction.type === "pfand" ? "(Pfand)" : ""}`
    )
    .join("\n") || "Nichts"
}`,
    Markup.inlineKeyboard([
      ...(page > 0
        ? [
            Markup.button.callback(
              `← Seite ${page}`,
              historyCallback.create({ page: (page - 1).toString(), username })
            ),
          ]
        : []),
      ...(page < numberPages - 1
        ? [
            Markup.button.callback(
              `Seite ${page + 2} →`,
              historyCallback.create({ page: (page + 1).toString(), username })
            ),
          ]
        : []),
    ])
  );
}

bot.command("list", async (ctx) => {
  if (!(await checkAdmin(ctx))) return;
  const users = await prisma.user.findMany();
  await ctx.replyWithHTML(
    users
      .map(
        (user) =>
          `${
            user.blocked
              ? "(B)"
              : !user.enabled
              ? "(I)"
              : user.admin
              ? "(A)"
              : ""
          } @${user.username}: ${user.value}${
            user.pfand > 0 ? ` (${user.pfand}P)` : ""
          }`
      )
      .join("\n")
  );
});

bot.command("admin", async (ctx) => {
  if (!(await checkAdmin(ctx))) return;
  try {
    const args = ctx.message.text.split(" ");
    if (args.length !== 2) throw new Error();
    if (args[1][0] !== "@") throw new Error();
    const username = args[1].substr(1);
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      await ctx.replyWithHTML(`@${username} wurde nicht gefunden`);
      return;
    }
    await prisma.user.update({
      where: { username },
      data: { admin: !user.admin },
    });
    ctx.replyWithHTML(
      user.admin
        ? `@${username} wurde Admin entfernt`
        : `@${username} wurde Admin hinzugefügt`
    );
  } catch {
    await ctx.replyWithHTML(
      `Fehler, Benutzung: <code>/admin @[username]</code>`
    );
    return;
  }
});

bot.command("block", async (ctx) => {
  if (!(await checkAdmin(ctx))) return;
  try {
    const args = ctx.message.text.split(" ");
    if (args.length !== 2) throw new Error();
    if (args[1][0] !== "@") throw new Error();
    const username = args[1].substr(1);
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      await ctx.replyWithHTML(`@${username} wurde nicht gefunden`);
      return;
    }
    await prisma.user.update({
      where: { username },
      data: { blocked: !user.blocked, enabled: user.blocked },
    });
    ctx.replyWithHTML(
      user.blocked
        ? `@${username} wurde entblockiert`
        : `@${username} wurde blockiert`
    );
  } catch {
    await ctx.replyWithHTML(
      `Fehler, Benutzung: <code>/admin @[username]</code>`
    );
    return;
  }
});

bot.command("announce", async (ctx) => {
  if (!(await checkAdmin(ctx))) return;
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    await ctx.replyWithHTML(
      `Fehler, Benutzung: <code>/announce [Nachricht]</code>`
    );
    return;
  }
  const users = await prisma.user.findMany({
    select: { id: true, username: true },
  });
  let message = "";
  let recipients: string[] = [];
  let error = false;
  while (args.length > 1) {
    const slice = args.pop();
    if (slice.startsWith("@")) {
      const username = slice.slice(1);
      const user = users.find((user) => user.username === username);
      if (!user) {
        await ctx.replyWithHTML(
          `Fehler, Username <code>@${username}</code> nicht gefunden`
        );
        error = true;
        continue;
      }
      recipients.push(user.id);
    } else {
      message = `${slice} ${message}`;
    }
  }
  if (error) return;
  if (recipients.length === 0) recipients = users.map((user) => user.id);
  recipients.forEach((userId) => bot.telegram.sendMessage(userId, message));
});

bot.command("help", async (ctx) => {
  if (!(await checkUser(ctx))) return;
  const user = await prisma.user.findUnique({
    where: { id: ctx.from.id.toString() },
  });
  let helpPage = `<b>MateBot</b> v${packagejson.version}

/drink - Eine Mate trinken
/check - Matestand abfragen
/return - Eine Pfandflasche zurückgeben
/history - Verlauf anzeigen
/help - Hilfe`;
  if (user.admin)
    helpPage += `

<b>ADMIN</b>
<code>/update @[username] ["+","-",""][Wert]</code> - Matestand von User ändern (entweder erhöhen, verringern oder neuen Wert eintragen)
<code>/updatep @[username] ["+","-",""][Wert]</code> - Ausstehndes Pfand von User ändern
<code>/updatetotal ["+","-",""][Wert]</code> - Totalen Matestand von ändern
/list - Alle Benutzer auflisten
<code>/admin @[username]</code> - User zu Admin machen / Admin entfernen
<code>/block @[username]</code> - User blockieren / entblockieren
<code>/announce [Nachricht]</code> - Nachricht an alle user senden
<code>/announce @[username] @[username] [Nachricht]</code> - Nachricht an bestimmte user senden
<code>/history @[username]</code> - Verlauf für User anzeigen
<code>/history all</code> - Gesamte Verlauf anzeigen`;
  await ctx.replyWithHTML(helpPage);
});

async function main() {
  const total = await prisma.total.findUnique({ where: { id: 0 } });
  if (!total) await prisma.total.create({ data: {} });
  await bot.launch();
  console.log("ready");
}

main();
