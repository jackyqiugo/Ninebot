import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import axios from "axios";
import moment from "moment";

// 在隔离上下文执行原脚本，避免测试读取真实账号或发送通知。
function loadScript(env = {}, timer = setTimeout) {
    const messages = [];
    const context = vm.createContext({
        axios: axios.create({ proxy: false }), moment, dotenv: { config() {} },
        fileURLToPath: () => new URL("../sign_ninebot.js", import.meta.url).pathname,
        dirname: () => ".", process: { env, exitCode: 0 },
        console: {
            log: (...args) => messages.push(args.join(" ")),
            error: (...args) => messages.push(args.join(" "))
        },
        setTimeout: timer
    });
    const source = readFileSync(new URL("../sign_ninebot.js", import.meta.url), "utf8")
        .replace(/^import .+;\r?\n/gm, "")
        .replace("import.meta.url", JSON.stringify(new URL("../sign_ninebot.js", import.meta.url).href))
        .replace(/\ninit\(\)(?:;|\.catch\([\s\S]*?\);)\s*$/, "\nglobalThis.api = { NineBot, init };");
    vm.runInContext(source, context);
    return { ...context.api, process: context.process, messages };
}

async function withServer(handler, action) {
    const server = createServer(handler);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
        await action(`http://127.0.0.1:${server.address().port}`);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

function json(response, data, status = 200) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(data));
}

test("登录验证失败必须返回失败", async () => {
    const { NineBot } = loadScript();
    await withServer((request, response) => json(response, { code: 1, msg: "验证失败" }), async url => {
        const bot = new NineBot("测试设备", "Bearer test-token");
        bot.endpoints.status = url;
        assert.equal(await bot.run(), false);
    });
});

test("签到接口拒绝请求必须返回失败", async () => {
    const { NineBot } = loadScript();
    await withServer((request, response) => {
        json(response, request.method === "GET"
            ? { code: 0, data: { currentSignStatus: 0 } }
            : { code: 1, msg: "签到失败" });
    }, async url => {
        const bot = new NineBot("测试设备", "Bearer test-token");
        bot.endpoints = { status: url, sign: url };
        assert.equal(await bot.run(), false);
    });
});

test("已签到必须返回成功且不再发起签到", async () => {
    const { NineBot } = loadScript();
    await withServer((request, response) => {
        assert.equal(request.method, "GET");
        json(response, { code: 0, data: { currentSignStatus: 1 } });
    }, async url => {
        const bot = new NineBot("测试设备", "Bearer test-token");
        bot.endpoints = { status: url, sign: url };
        assert.equal(await bot.run(), true);
    });
});

test("签到成功后的状态查询失败不应否定签到结果", async () => {
    const { NineBot } = loadScript();
    let reads = 0;
    await withServer((request, response) => {
        if (request.method === "POST") return json(response, { code: 0 });
        reads++;
        json(response, reads === 1
            ? { code: 0, data: { currentSignStatus: 0 } }
            : { code: 1, msg: "状态暂不可用" });
    }, async url => {
        const bot = new NineBot("测试设备", "Bearer test-token");
        bot.endpoints = { status: url, sign: url };
        assert.equal(await bot.run(), true);
    });
});

test("三次连接重置后仍能继续重试并成功", async () => {
    const { NineBot } = loadScript();
    let attempts = 0;
    await withServer((request, response) => {
        if (++attempts <= 3) return request.socket.destroy();
        json(response, { code: 0 });
    }, async url => {
        const bot = new NineBot("测试设备", "Bearer test-token");
        bot.requestConfig.retryDelay = 1;
        assert.equal((await bot.makeRequest("get", url)).code, 0);
        assert.equal(attempts, 4);
    });
});

test("401 授权失败应直接结束请求", async () => {
    const { NineBot } = loadScript();
    let attempts = 0;
    await withServer((request, response) => {
        attempts++;
        json(response, { msg: "授权失败" }, 401);
    }, async url => {
        const bot = new NineBot("测试设备", "Bearer test-token");
        bot.requestConfig.retryDelay = 1;
        await assert.rejects(bot.makeRequest("get", url));
        assert.equal(attempts, 1);
    });
});

test("网络持续断开时最多尝试五次，等待时间有上限", async () => {
    const delays = [];
    const { NineBot } = loadScript({}, (callback, delay) => {
        delays.push(delay);
        callback();
    });
    let attempts = 0;
    await withServer(request => {
        attempts++;
        request.socket.destroy();
    }, async url => {
        const bot = new NineBot("测试设备", "Bearer test-token");
        bot.endpoints.status = url;
        assert.equal(await bot.run(), false);
        assert.equal(attempts, 5);
        assert.deepEqual(delays, [5000, 10000, 20000, 30000]);
    });
});

test("多账号出现失败时仍处理其余账号并设置失败退出码", async () => {
    const env = { NINEBOT_ACCOUNTS: JSON.stringify([
        { deviceId: "设备一", authorization: "Bearer test-token" },
        { deviceId: "设备二", authorization: "Bearer test-token" }
    ]) };
    const loaded = loadScript(env);
    const processed = [];
    loaded.NineBot.prototype.run = async function () {
        processed.push(this.deviceId);
        // 文案含“已签到”也不能覆盖明确失败的结果。
        this.msg.push({ name: "验证结果", value: "无法读取已签到状态" });
        return this.deviceId === "设备二";
    };
    await loaded.init();
    assert.deepEqual(processed, ["设备一", "设备二"]);
    assert.equal(loaded.process.exitCode, 1);
    assert.ok(loaded.messages.some(message => message.includes("九号出行签到结果")));
});

test("多账号全部成功应保持成功退出码", async () => {
    const loaded = loadScript({ NINEBOT_ACCOUNTS: JSON.stringify([
        { deviceId: "测试设备", authorization: "Bearer test-token" }
    ]) });
    loaded.NineBot.prototype.run = async () => true;
    await loaded.init();
    assert.equal(loaded.process.exitCode, 0);
});

for (const [name, value] of [["缺少账号", undefined], ["JSON 错误", "{"], ["空账号列表", "[]"]]) {
    test(`${name}必须以非零退出码结束进程`, () => {
        const env = { ...process.env };
        for (const key of Object.keys(env)) {
            if (key.startsWith("NINEBOT_") || key.startsWith("BARK_")) delete env[key];
        }
        env.NINEBOT_DEVICE_ID = "";
        env.NINEBOT_AUTHORIZATION = "";
        env.NINEBOT_ACCOUNTS = "";
        env.BARK_KEY = "";
        if (value !== undefined) env.NINEBOT_ACCOUNTS = value;
        const result = spawnSync(process.execPath, ["sign_ninebot.js"], {
            cwd: new URL("../", import.meta.url), env, encoding: "utf8"
        });
        assert.equal(result.status, 1, result.stderr);
    });
}
