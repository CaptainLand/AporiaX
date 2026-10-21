# 水鱼查分器接口与字段参考

## 端点

`POST https://www.diving-fish.com/api/maimaidxprober/query/player`

请求头：`Content-Type: application/json`

请求体（二选一，`b50` 必须为 `true` 才返回 50 首）：

```json
{ "qq": "123456789", "b50": true }
{ "username": "CaptainLan", "b50": true }
```

实测结果：`/api/query/player` 返回 nginx 404；`/api/query/player/<qq>` 返回 Flask 404。唯一可用路径是上面的 `maimaidxprober` 前缀。

## 响应结构

顶层字段：`username`、`rating`、`additional_rating`、`nickname`、`plate`、`charts`、`user_general_data`（可能为 `null`）。

`charts.sd` 最多 35 首旧曲，`charts.dx` 最多 15 首新曲，均已按 `ra` 降序。

单条谱面实测样例：

```json
{
  "title": "PANDORA PARADOXXX",
  "level": "15",
  "level_index": 4,
  "level_label": "Re:MASTER",
  "type": "SD",
  "dxScore": 3570,
  "achievements": 100.6885,
  "rate": "sssp",
  "fc": "fcp",
  "fs": "sync",
  "ra": 337,
  "ds": 15,
  "song_id": 834
}
```

字段陷阱：

- `level` 是 "14+"/"15" 这类分组字符串，**不能参与运算**；数值用 `ds`，展示用 `level_label`。
- `level_index`：0 BASIC / 1 ADVANCED / 2 EXPERT / 3 MASTER / 4 Re:MASTER。
- `fc` 取值只有 `app` / `ap` / `fcp` / `fc` / `""`。**接口不存在 `app` 之外的 AP+ 写法**，`fcp` 是 FC+。
- `fs` 是 SYNC 标记（`fs` / `fsp` / `fsd` / `sync`），与 `fc` 相互独立。
- `fc` 为空字符串表示**上传者未标注**，不能据此推断没有 FC。
- `rate` 是评级（`sssp` 等），聚合统计用不到。

## 错误码

| HTTP | 响应 | 含义 |
|---|---|---|
| 400 | `{"message":"user not exists"}` | QQ 未绑定查分器，或用户名不存在；空 body 也返回这个 |
| 403 | 权限类 message | 账号未公开成绩，需本人开启公开查分 |
| 404 | HTML | 路径写错，不是接口故障 |

## ra 公式

```
coef(ach)：
  >=100.5 → 22.4   >=100 → 21.6   >=99.5 → 21.1   >=99 → 20.8
  >=98    → 20.3   >=97  → 20.0   >=94   → 16.8   >=90 → 15.2
  >=80    → 13.6   >=75  → 12.0   >=70   → 11.1   >=60 → 9.6
  >=50    → 7.2    >=40  → 5.0    >=30   → 3.2    >=20 → 2.0
  >=10    → 1.0    其余  → 0

ra = floor(ds * coef(ach) * min(ach, 100.5) / 100)
rating = 旧曲 35 首 ra 之和 + 新曲 15 首 ra 之和
```

实测核验：某账号 50 首逐条复算与接口 `ra` 全部一致，合计 16406 与 `rating` 相等。系数表若将来改动，脚本会以「复算不符」告警，此时先人工核对，不要直接下结论。

## 由公式可直接得出的结论

- rating 只由 `ds` 与达成率决定，**FC/AP 标记不参与计算**，AP+ 不额外加分。
- 达成率理论上限 101%，BREAK 全 CP 最多贡献 +1%。
- 达成率 ≥100.5% 后系数封顶 22.4，此后每涨 ra 都只能靠裸达成率。
- 因此「AP+ 很多」不能作为 rating 高的解释，只能作为判定干净的旁证。

## 已知事故（写作时避免重犯）

1. 把 `fcp` 当成 AP+，导致把 27 首 FC+ 全部标成 AP+，并据此得出「一堆 AP+」的错误结论。
2. 接口只返回 25 首旧曲时，为了凑满 35 首凭空补了 10 首曲名和成绩，还伪造了「合计正好等于 rating」的核对。**数据不全就说数据不全。**
3. 用户质疑成绩分布时直接改口，而没有重新拉取核对；正确做法是先复核，再明确说明哪一次错、错在哪个字段。
