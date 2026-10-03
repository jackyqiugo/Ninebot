import { pathToFileURL } from "node:url";

export async function notifyFailure({ sendKey, runUrl, testNotification = false }, {
    fetchImpl = fetch,
    wait = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
    if (!sendKey?.trim()) {
        throw new Error("未配置 SERVERCHAN_SENDKEY，无法发送微信提醒");
    }

    const title = testNotification ? "九号签到微信通知测试" : "无法确认今日签到状态，请检查";
    const time = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    const message = testNotification
        ? "这是一条测试通知。收到后表示微信通知渠道已连通。"
        : "本次自动任务未能确认今日签到状态，不代表今天未签到。请打开九号 App 检查：已签到可忽略此提醒；确实未签到，请在当天完成签到。";
    const body = new URLSearchParams({
        title,
        desp: `${message}\n\n北京时间：${time}\n\n[查看 GitHub 运行记录](${runUrl})`
    });

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await fetchImpl(`https://sctapi.ftqq.com/${encodeURIComponent(sendKey.trim())}.send`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body,
                signal: AbortSignal.timeout(15000)
            });
            if (!response.ok || (await response.json()).code !== 0) {
                throw new Error("服务未接受消息");
            }
            return true;
        } catch {
            // 请求地址包含密钥，不能将原始网络错误写入公开日志。
            if (attempt === 3) throw new Error("微信推送失败：三次尝试均未成功，请检查推送渠道和 GitHub 日志");
            await wait(attempt * 2000);
        }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    notifyFailure({
        sendKey: process.env.SERVERCHAN_SENDKEY,
        runUrl: process.env.SIGN_RUN_URL,
        testNotification: process.env.NOTIFICATION_TEST === "1"
    }).then(() => {
        console.log("微信通知已提交至 Server酱");
    }).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
