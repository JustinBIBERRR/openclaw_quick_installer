# Windows 环境画像说明

每个 profile 使用 JSON 描述，字段约定：

- `id`: 唯一标识
- `description`: 场景说明
- `simulate`: 注入行为开关
- `expected`: 期望结果与阻断等级

`simulate` 支持字段：

- `nodeMode`: `ready | missing | old16`
- `wingetAvailable`: `true | false`
- `hideGit`: `true | false`
- `hideBash`: `true | false`
- `hideDocker`: `true | false`
- `occupyPort18789`: `true | false`
- `brokenOpenclawConfig`: `true | false`
- `installDirMode`: `default | chinese | withSpaces`
- `networkRestricted`: `true | false`

这些画像用于手测脚本和本地模拟，不会修改系统级配置。
