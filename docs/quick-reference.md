# codex-gateway 快速参考

## 接入信息

### Claude Opus 4.6（HTTPS）
```
Base URL:  https://claude.meltemi.fun
API Key:   sk-aop-460039f571bc81d5718f50783d79b24b837e20baf2b2f97f
Model ID:  claude-opus-4-6
协议:      OpenAI 或 Anthropic 均可
```

### GPT-5.4 及全系列（HTTPS）
```
Base URL:  https://gpt.meltemi.fun/v1
API Key:   sk-cgw-c6e3614ddfecae03cf0825c027ffd64d9e77338bb1b08850
Model ID:  gpt-5.4 (小写)
协议:      OpenAI
```

### 内网直连（Tailscale）
```
Claude:  http://100.74.249.26:8320
GPT:     http://100.74.249.26:8319/v1
```

## 可用 GPT 模型

| 模型 ID | 说明 |
|---------|------|
| gpt-5.4 | 最新 |
| gpt-5.3-codex | 代码优化 |
| gpt-5.2-codex | 代码优化 |
| gpt-5.2 | 通用 |
| gpt-5.1-codex-max | 代码+长上下文 |
| gpt-5.1-codex | 代码优化 |
| gpt-5.1 | 通用 |
| gpt-5-codex | 代码优化 |
| gpt-5 | 通用 |
| gpt-5.1-codex-mini | 轻量快速 |
| gpt-5-codex-mini | 轻量快速 |

## 常用端点

```bash
# 查看模型列表
curl -H "Authorization: Bearer $KEY" https://gpt.meltemi.fun/v1/models

# 查看账号状态
curl -H "Authorization: Bearer $KEY" https://gpt.meltemi.fun/v1/accounts

# 查看用量统计
curl -H "Authorization: Bearer $KEY" https://gpt.meltemi.fun/v1/stats

# 手动触发 auth 同步
curl -X POST -H "Authorization: Bearer $KEY" https://gpt.meltemi.fun/v1/auth-sync

# 发送请求
curl -X POST https://gpt.meltemi.fun/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"hello"}]}'
```

## 账号管理

### 添加新账号（Mac 上操作）
```bash
codex auth login          # 浏览器登录
# 登录后 ~/.codex/auth.json 会更新
# 重命名为 auth-{label}.json
mv ~/.codex/auth.json ~/.codex/auth-newaccount.json
# gateway 60 秒内自动检测到新账号
```

### 查看账号状态
```bash
curl -s -H "Authorization: Bearer $KEY" https://gpt.meltemi.fun/v1/accounts | python3 -m json.tool
```

## 运维

### VPS 重启 gateway
```bash
ssh vps 'systemctl restart codex-gateway'
```

### VPS 查看日志
```bash
ssh vps 'tail -50 /root/codex-gateway/gateway.log'
```

### Mac 重启 gateway
```bash
launchctl unload ~/Library/LaunchAgents/com.codex-gateway.plist
launchctl load ~/Library/LaunchAgents/com.codex-gateway.plist
```

### 更新代码部署
```bash
# Mac
cd ~/Documents/yulong/codex-gateway && git pull

# VPS
ssh vps 'cd /root/codex-gateway && git pull && systemctl restart codex-gateway'
```
