import test from "node:test";
import assert from "node:assert/strict";

const options = {
    sendKey: "SCTtestkey",
    runUrl: "https://github.com/jackyqiugo/Ninebot/actions/runs/123",
    testNotification: false
};

async function loadNotifier() {
    return (await import("../notify_failure.js")).notifyFailure;
}

function accepted() {
    return { ok: true, status: 200, json: async () => ({ code: 0 }) };
}

test("失败通知通过 Server酱发送补签提醒和运行记录", async () => {
    const notifyFailure = await loadNotifier();
    let request;
    await notifyFailure(options, {
        fetchImpl: async (url, config) => {
            request = { url, config };
            return accepted();
        }
    });
    assert.equal(request.url, "https://sctapi.ftqq.com/SCTtestkey.send");
    assert.equal(request.config.method, "POST");
    const body = new URLSearchParams(request.config.body);
    assert.match(body.get("title"), /失败/);
    assert.match(body.get("desp"), /补签/);
    assert.ok(body.get("desp").includes(options.runUrl));
    assert.ok(!body.get("desp").includes(options.sendKey));
});

test("缺少推送密钥时不能假装发送成功", async () => {
    const notifyFailure = await loadNotifier();
    let called = false;
    await assert.rejects(notifyFailure({ ...options, sendKey: "" }, {
        fetchImpl: async () => { called = true; return accepted(); }
    }), /SERVERCHAN_SENDKEY/);
    assert.equal(called, false);
});

test("测试通知明确标识为测试", async () => {
    const notifyFailure = await loadNotifier();
    let title;
    await notifyFailure({ ...options, testNotification: true }, {
        fetchImpl: async (url, config) => {
            title = new URLSearchParams(config.body).get("title");
            return accepted();
        }
    });
    assert.match(title, /测试/);
    assert.doesNotMatch(title, /失败/);
});

test("推送临时网络失败后重试", async () => {
    const notifyFailure = await loadNotifier();
    let attempts = 0;
    await notifyFailure(options, {
        fetchImpl: async () => {
            if (++attempts < 3) throw new Error("暂时断网");
            return accepted();
        },
        wait: async () => {}
    });
    assert.equal(attempts, 3);
});

test("HTTP成功但推送服务拒绝消息时也要报告失败", async () => {
    const notifyFailure = await loadNotifier();
    await assert.rejects(notifyFailure(options, {
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 40001 }) }),
        wait: async () => {}
    }), /推送失败/);
});

test("推送持续失败最多尝试三次且错误信息不泄露 SendKey", async () => {
    const notifyFailure = await loadNotifier();
    let attempts = 0;
    await assert.rejects(notifyFailure(options, {
        fetchImpl: async () => {
            attempts++;
            throw new Error(`请求失败：https://sctapi.ftqq.com/${options.sendKey}.send`);
        },
        wait: async () => {}
    }), error => {
        assert.match(error.message, /推送失败/);
        assert.ok(!error.message.includes(options.sendKey));
        return true;
    });
    assert.equal(attempts, 3);
});
