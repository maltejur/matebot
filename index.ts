import { Context, deunionize, Markup, Telegraf } from "telegraf";
import * as dotenv from "dotenv";
import packagejson from "./package.json";
import { PrismaClient } from "@prisma/client";
import { CallbackData } from "telegraf-callback-data";
import type { Update } from "telegraf/typings/core/types/typegram";
import tgresolve from "tg-resolve";
dotenv.config();

const prisma = new PrismaClient();

if (!process.env.BOT_TOKEN) throw new Error("No bot token");
const bot = new Telegraf(process.env.BOT_TOKEN);

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
  const allowed = !!user;
  if (!allowed) ctx.replyWithHTML("Du bist nicht freigeschaltet");
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
  const id = ctx.from.id.toString();
  const user = await prisma.user.findUnique({
    where: { id },
  });
  if (!user) {
    ctx.replyWithHTML(
      `<b>MateBot</b> v${packagejson.version}\n\nAccount wurde noch nicht freigeschaltet`
    );
  } else {
    await ctx.replyWithHTML(`<b>MateBot</b> v${packagejson.version}`);
    checkMate(ctx);
  }
});

bot.command("adduser", async (ctx) => {
  if (!(await checkAdmin(ctx))) return;
  try {
    const args = ctx.message.text.split(" ");
    if (args.length !== 2) throw new Error();
    const id = Number.parseInt(args[1]);
    if (!id) throw new Error();
    await prisma.user.create({
      data: { id: id.toString() },
    });
    ctx.replyWithHTML(`<code>${id}</code> hinzugefügt`);
  } catch {
    ctx.replyWithHTML(
      `Fehler, Benutzung: <code>/adduser [userid]</code>\nID lässt sich mit @username_to_id_bot rausfinden`
    );
    return;
  }
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
  if (user.value < 1) {
    await ctx.reply("Keine Mate mehr gutgeschrieben");
    await checkMate(ctx);
    return;
  }
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
    if (newValue < 0) {
      ctx.replyWithHTML(
        `Fehler: Neuer Matestand dark nicht unter 0 liegen, Benutzung: <code>/update @[username] ["+","-",""][Wert]</code>`
      );
      return;
    }
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
    ctx.replyWithHTML(
      `Matestand von @${username} aktualisiert, neuer Stand: <code>${newValue}</code>`
    );
  } catch {
    ctx.replyWithHTML(
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

bot.launch().then(() => console.log("ready"));
