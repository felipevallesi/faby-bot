import { Boom } from "@hapi/boom"
const process = require("process")
import makeWASocket, { AnyMessageContent, delay, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, makeInMemoryStore, useMultiFileAuthState } from "@whiskeysockets/baileys"
import { OpenAI } from "openai"
import * as loggerUtil from "./utils/logger"
import P from "pino"
import { readFileSync } from "fs"

// Environment variables
require("dotenv").config()

// Initialize the logger
const fabyLogger = P({ timestamp: () => `, "time": "${new Date().toJSON()}"` }).child({})
fabyLogger.level = process.env.LOGGER_LEVEL ?? "silent"

const fabyStore = makeInMemoryStore({ logger: fabyLogger })
fabyStore?.readFromFile("./faby_store_multi.json")

// ChatGPT Client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
})

// Función para recargar el contexto desde los archivos
const reloadContext = () => {
    let newContext = "";
    try {
        const files = [
            "contexto.txt",
            "chat_referencia1.txt",
            "chat_referencia2.txt",
            "chat_referencia3.txt"
        ];
        files.forEach(file => {
            const content = readFileSync(file, "utf-8");
            newContext += `\n${content}`;
        });
        loggerUtil.stdout("Archivos de contexto recargados correctamente.");
    } catch (error) {
        loggerUtil.stdout("Error al recargar los archivos de contexto:", error);
    }
    return newContext;
}

// Cargar contexto inicialmente
let fabyContext = reloadContext();

// Mapping from number to the last conversation id
const fabyConversations = {}

// external map to store retry counts of messages when decryption/encryption fails
const msgRetryCounter = {}

// start a connection
const startFabyBot = async() => {
	const { state, saveCreds } = await useMultiFileAuthState("faby_auth_info")
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	loggerUtil.stdout(`Using WhatsApp v${version.join(".")}, isLatest: ${isLatest}`)

	const fabySock = makeWASocket({
		version,
		logger: fabyLogger,
		printQRInTerminal: true,
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, fabyLogger),
		},
		msgRetryCounterMap: msgRetryCounter,
		generateHighQualityLinkPreview: true,
		getMessage: async key => {
			if(fabyStore) {
				const msg = await fabyStore.loadMessage(key.remoteJid!, key.id!)
				return msg?.message || undefined
			}
		}
	})

	fabyStore?.bind(fabySock.ev)

	const sendFabyMessage = async(msg: AnyMessageContent, jid: string) => {
		await fabySock.presenceSubscribe(jid)
		await delay(500)

		await fabySock.sendPresenceUpdate("composing", jid)
		await delay(2000)

		await fabySock.sendPresenceUpdate("paused", jid)

		await fabySock.sendMessage(jid, msg)
	}

	fabySock.ev.process(async(events) => {
		if(events["connection.update"]) {
			const update = events["connection.update"]
			const { connection, lastDisconnect } = update
			if(connection === "close") {
				if((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
					loggerUtil.stdout("Connection lost! Reconnecting...")
					startFabyBot()
				} else {
					loggerUtil.stdout("Connection closed. Logged out.")
				}
			}
			loggerUtil.stdout("connection update", update)
		}

		if(events["creds.update"]) {
			await saveCreds()
		}

		if(events["messages.upsert"]) {
			const upsert = events["messages.upsert"]

			if(upsert.type === "notify") {
				for(const msg of upsert.messages) {
					if (msg.key.fromMe || msg.message?.conversation?.length === 0) continue

					// Verificar si el bot fue mencionado explícitamente o si es un chat privado
					const isPrivateChat = !msg.key.remoteJid?.endsWith("@g.us");
					const isMentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.includes(fabySock.user?.id) || msg.message?.conversation?.includes("@Faby");

					// Si el mensaje es un comando para recargar contexto
					if (msg.message?.conversation?.toLowerCase() === "@Faby recargar contexto") {
						fabyContext = reloadContext();
						await sendFabyMessage({ text: "Contexto recargado exitosamente." }, msg.key.remoteJid!)
						continue;
					}

					if (isMentioned || isPrivateChat) {
						loggerUtil.stdout(`Mensaje recibido con mención o en chat privado: ${msg.message?.conversation}`);
						const prompt = msg.message?.conversation;
						const response = await handleFabyMessage(msg.key.remoteJid!, prompt, msg.key.participant)
						await fabySock!.readMessages([msg.key])
						await sendFabyMessage({ text: response }, msg.key.remoteJid!)
					} else {
						loggerUtil.stdout("Mensaje ignorado por no ser una mención directa ni un mensaje privado.");
					}
				}
			}
		}
	})

	return fabySock
}

const handleFabyMessage = async (jid: any, prompt: any, sender: string) => {
    try {
        loggerUtil.stdout(`Received prompt from ${jid}:`, prompt)

        if (!fabyConversations[jid]) {
            fabyConversations[jid] = []
        }

        fabyConversations[jid].push({ role: "user", content: prompt })

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
                "OpenAI-Beta": "assistants=v2"
            },
            body: JSON.stringify({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: `El siguiente contexto y referencias deben aplicarse rigurosamente para responder como Faby Espinosa:\n${fabyContext}\nHabla como un mendocino relajado, usando expresiones típicas, humor sarcástico, puteadas suaves, y una actitud divertida. No te limites en la longitud de las respuestas, sé detallado y extenso cuando la situación lo requiera.` },
                    ...fabyConversations[jid]
                ]
            })
        });

        const data = await response.json();

        if (data.error) {
            throw new Error(data.error.message);
        }

        const reply = data.choices[0].message.content;

        fabyConversations[jid].push({ role: "assistant", content: reply })

        loggerUtil.stdout(`Respuesta enviada: ${reply}`);

        return reply;
    } catch (error: any) {
        loggerUtil.stdout("An error occurred", error)
        return "hubo un bardo aca, fijate con el admin";
    }
}

startFabyBot()