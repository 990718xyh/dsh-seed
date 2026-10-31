# dsh-seed

[中文](README.md) | [English](README.en.md)

**给 DSH 从零长出来的人格。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.2.0-blue)](https://github.com/deepseek-ai/deepseek-harness)

DSH 新开一个会话就从头开始。你说过的规矩、定过的边界、踩过的坑，下一轮全没了。

人设卡能解决「它像不像一个人」，解决不了「它还记不记得你」。记忆插件能记住事实，但不会因此变成谁。

dsh-seed 两件事一起做：记住发生过什么，再从里面长出一个自己。

## 装上之后多出什么

**新会话不用重讲。** 每轮开头会把你叫它什么、你们谈定的边界、踩过的坑重新放进上下文。你上次说「周日别找我」，下回它自己记得。

**它自己会变。** 攒够经历它改「我是谁」那一版，改之前出候选、过审，证据不足就驳回。

**你能看见它。** 面板里九层各多少条、自述现在是第几版、这一轮往上下文里塞了多少字。

## 安装

在「Add plugin」向导里搜 `dsh-seed`，或者用 CLI：

```sh
dsh plugin --profile desktop add github:990718xyh/dsh-seed
```

浏览器版把 `desktop` 换成 `web`。装完重启 DSH。

别急着看面板，先聊两句——第一轮结束它才开始记。

## 每轮在跑什么

```
轮末
 │
 ├─ 抽取：这一轮里有什么值得留
 │
 ├─ 治理：新来的跟旧的什么关系
 │     ADD / UPDATE / DELETE / NOOP / DEFER
 │
 ├─ 攒够 5 条没嚼过的 → 反思：抽出判断，每条挂事件 id
 │
 └─ 攒够判断 → 自述：出候选 → 审查 → 落盘或驳回
```

抽取和提炼都走小模型，失败只写审计，不打断对话。

## 特性

- **事实永不物理删除**：说错了标 `invalid`、留失效时间，以后能查当时为什么信。
- **记忆强度**：被检索到一次 `+0.05`（封顶 1.0），没用到每天 `×0.998`（下限 0.1）。称呼、约定、禁忌钉住，永不衰减，每轮固定注入。
- **反思必须带证据**：每条判断挂真实事件 id，挂不上就丢。不然模型会把自己的推测写成你的原话。
- **自述有闸门**：改「我是谁」先出 proposal，过 review 才落盘；证据不足驳回并回滚。
- **检索**：Unicode 分词（CJK bigram / 其他语言整词 / NFKC），idf 加权 + BM25 长度归一化；匹配到本轮最高分 `85%` 的条目不吃时间衰减。
- **只收三类关于你的事**：怎么称呼你、谈定的边界、明确禁止的。什么都记等于什么都抓不住。
- **零依赖**：只用 `node:` 内置模块，没有原生扩展，不构建。

## 配置

`~/.dsh/profiles/<profile>/cordis.patch.yml`：

```yaml
- insert:
    - id: persona
      name: 'dsh-seed'
      config:
        id: seed
        dir: ~/.dsh/persona
        heartbeat: { enabled: true, everyMinutes: 30 }
        study: { enabled: false }
        panel: { enabled: true, route: /persona, port: 8787 }
```

`id` 是数据目录名。`llm` 不写就跟着当前选中的模型走——写死会在换模型后报 no API key，抽取整条链静默停掉。

自学默认关。要联网、要花钱，想开再开。

> 面板起在 8787。端口被占用时改 `panel.port`，不然面板起不来，只在审计里留一条 `panel-error`。

## 数据

`~/.dsh/persona/<id>/`，纯文本，能直接翻：

```
journal/<host>.jsonl   所有写入，只追加
snapshot/base.json     压实后的基线
heartbeat.json         心跳状态
```

## 卸载

```sh
dsh plugin --profile desktop remove dsh-seed
```
