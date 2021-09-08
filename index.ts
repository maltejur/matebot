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

async function checkUser(ctx: Context<Update>) {
  const id = ctx.from.id.toString();
  const user = await prisma.user.findUnique({
    where: { id },
  });
  if (user && !user.username) {
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

async function checkMate(ctx: Context<Update>) {
  const user = await prisma.user.findUnique({
    where: { id: ctx.from.id.toString() },
  });
  await ctx.replyWithHTML(
    `Mate Verfügbar: <code>${user.value}</code>`,
    Markup.keyboard([
      Markup.button.text("/check"),
      Markup.button.text("/drink"),
    ])
  );
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
    Markup.keyboard([
      Markup.button.text("/check"),
      Markup.button.text("/drink"),
    ])
  );
  await ctx.answerCbQuery(`@${user.username} wurde aktiviert`);
});

bot.action(blockUserCallback.filter(), async (ctx) => {
  const { id } = blockUserCallback.parse(deunionize(ctx.callbackQuery).data);
  if (!checkAdmin(ctx)) return;
  const user = await prisma.user.update({
    where: { id },
    data: { enabled: false, blocked: true },
  });
  await ctx.answerCbQuery(`@${user.username} wurde blockiert`);
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
  await prisma.user.update({ where: { id }, data: { value: user.value - 1 } });
  await prisma.transactions.create({
    data: { userId: id, authorId: id, change: -1 },
  });
  await ctx.reply(`Mate getrunken`);
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
    await prisma.user.update({
      where: { username },
      data: { value: newValue },
    });
    await prisma.transactions.create({
      data: {
        userId: user.id,
        authorId: ctx.from.id.toString(),
        change: newValue - user.value,
      },
    });
    await bot.telegram.sendMessage(
      user.id,
      `Dein Matestand wurde von @${ctx.from.username} aktualisiert, neuer Stand: ${newValue}`
    );
    await ctx.replyWithHTML(
      `Matestand von @${username} aktualisiert, neuer Stand: <code>${newValue}</code>`
    );
  } catch {
    await ctx.replyWithHTML(
      `Fehler, Benutzung: <code>/update @[username] ["+","-",""][Wert]</code>`
    );
    return;
  }
});

bot.command("history", async (ctx) => {
  if (!(await checkUser(ctx))) return;
  const transactions = await prisma.transactions.findMany({
    where: { userId: ctx.from.id.toString() },
    include: { user: true },
    orderBy: {
      date: "asc",
    },
  });
  ctx.replyWithHTML(
    `${transactions
      .map(
        (transaction) =>
          `${transaction.date.toLocaleDateString()} ${transaction.date.toLocaleTimeString()} von @${
            transaction.user.username
          } ${
            transaction.change >= 0
              ? `+${transaction.change}`
              : transaction.change
          }`
      )
      .join("\n\n")}`
  );
});

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
          } @${user.username}: ${user.value}`
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

bot.command("help", async (ctx) => {
  if (!(await checkUser(ctx))) return;
  const user = await prisma.user.findUnique({
    where: { id: ctx.from.id.toString() },
  });
  let helpPage = `/drink - Eine Mate trinken
/check - Matestand abfragen
/history - Transaktionsgeschichte anzeigen
/help - Hilfe`;
  if (user.admin)
    helpPage += `\n<code>/update @[username] ["+","-",""][Wert]</code> - Matestand von User ändern (entweder erhöhen, verringern oder neuen Wert eintragen)
/list - Alle Benutzer auflisten
<code>/admin @[username]</code> - User zu Admin machen / Admin entfernen
<code>/block @[username]</code> - User blockieren / entblockieren`;
  await ctx.replyWithHTML(helpPage);
});

bot.launch().then(() => console.log("ready"));
