/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import "source-map-support/register.js";
import "dotenv/config";

import crypto from "node:crypto";

import cors from "@fastify/cors";
import Fastify, { FastifyRequest } from "fastify";
import Redis from "ioredis";
import fetch from "node-fetch";

const fastify = Fastify();
const redis = new Redis(process.env.REDIS_URI!);

const SIZE_LIMIT = parseInt(process.env.SIZE_LIMIT!);
const ABOUT = `
<h1>Vencord API</h1>
<p>This is the API used by Vencord features like Settings Sync. If you are wondering why requests are sent here, it's because you explicitly opted into Settings Sync. You can disable it at any point!</p>
<p>But no worries, this api <a href="/basic-privacy-policy">takes your privacy serious</a> and is <a href="https://github.com/Vencord/Backend">free and open source!</a></p>
`.trim();

function hash(data: string) {
    return crypto.createHash("sha1").update(data).digest("hex");
}

await fastify.register(cors, { exposedHeaders: ["ETag"] });

// #region request decoration & correction
fastify.decorateRequest("userId", null);
fastify.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, async (_request: FastifyRequest, body: Buffer) => {
    return body;
});

declare module "fastify" {
    export interface FastifyRequest {
        userId: string;
    }
}
// #endregion

// #region settings
// hook to force authorization when dealing with settings requests
fastify.addHook("onRequest", async (request, reply) => {
    if (request.routerPath !== "/settings") {
        return;
    }

    const authToken = request.headers.authorization;

    if (!authToken) {
        return reply.status(401).send({ error: "Missing authorization" });
    }

    const auth = Buffer.from(authToken, "base64")
        .toString("ascii")
        .split(":");

    if (auth.length !== 2) {
        return reply.status(401).send({ error: "Invalid authorization" });
    }

    const userId = auth[0];
    const secret = auth[1];

    const storedSecret = await redis.get(`secrets:${hash(process.env.PEPPER_SECRETS! + userId)}`);

    if (storedSecret !== secret) {
        return reply.status(401).send({ error: "Invalid authorization" });
    }

    request.userId = userId;
});

fastify.head("/settings", async (request, reply) => {
    const userIdHash = hash(process.env.PEPPER_SETTINGS! + request.userId);
    const written = await redis.hget(`settings:${userIdHash}`, "written");

    if (!written) {
        return reply.status(404);
    }

    return reply.header("ETag", written);
});

fastify.get("/settings", async (request, reply) => {
    const userIdHash = hash(process.env.PEPPER_SETTINGS! + request.userId);
    const [settings, written] = await Promise.all([
        redis.hgetBuffer(`settings:${userIdHash}`, "value"),
        redis.hget(`settings:${userIdHash}`, "written")
    ]);

    if (!settings) {
        return reply.status(404).send({ error: "No settings currently synchronized" });
    }

    reply.header("ETag", written!);
    return settings!;
});

fastify.put("/settings", async (request, reply) => {
    if (request.headers["content-type"] !== "application/octet-stream") {
        return reply.status(415).send({ error: "Content type must be `application/octet-stream`" });
    }

    if ((request.body as Buffer).byteLength > SIZE_LIMIT) {
        return reply.status(413).send({ error: "Settings are too large" });
    }

    const now = Date.now();

    await redis.hmset(`settings:${hash(process.env.PEPPER_SETTINGS! + request.userId)}`, {
        value: request.body,
        written: now
    });

    return { written: now };
});

fastify.delete("/settings", async (request, reply) => {
    await redis.del(`settings:${hash(process.env.PEPPER_SETTINGS! + request.userId)}`);

    return reply.status(204);
});
// #endregion

// #region discord oauth
fastify.get("/authorize", async (request, reply) => {
    return reply.redirect(
        302,
        `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(
            process.env.DISCORD_REDIRECT_URI!
        )}&response_type=code&scope=identify`
    );
});

fastify.get("/callback", async (request, reply) => {
    const code = (request.query as any).code as string;

    if (!code) {
        return reply.status(400).send({ error: "Missing code" });
    }

    const body = new URLSearchParams();
    body.set("client_id", process.env.DISCORD_CLIENT_ID!);
    body.set("client_secret", process.env.DISCORD_CLIENT_SECRET!);
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("redirect_uri", process.env.DISCORD_REDIRECT_URI!);

    const res = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body
    });

    if (!res.ok) {
        return reply.status(400).send({ error: "Invalid code" });
    }

    const { access_token: accessToken } = await res.json() as { access_token: string; };

    const userRes = await fetch("https://discord.com/api/users/@me", {
        headers: {
            authorization: `Bearer ${accessToken}`
        }
    });

    if (!userRes.ok) {
        return reply.status(500).send({ error: "Failed to get user" });
    }

    const { id: userId } = await userRes.json() as { id: string; };

    const hashId = hash(process.env.PEPPER_SECRETS + userId);

    let secret = await redis.get(`secrets:${hashId}`);

    if (!secret) {
        secret = crypto.randomBytes(48).toString("hex");
        await redis.set(`secrets:${hashId}`, secret);
    }

    return { secret };
});
// #endregion

fastify.get("/", (_, reply) => reply.type("text/html").send(ABOUT));

await fastify.listen({ host: process.env.HOST!, port: parseInt(process.env.PORT!) });
