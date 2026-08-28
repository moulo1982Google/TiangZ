# 故障排查

## Windows代码生成后出现大量CRLF/LF修改

仓库文本和生成物统一使用LF，根目录`.gitattributes`负责覆盖不同电脑的Git全局换行设置。Windows上如果`core.autocrlf=true`，旧工作区可能先以CRLF检出文件，随后又被codegen写回LF，于是`app/generated`、`client_sdk`、客户端`Generated`和`src/generated`同时显示大量修改。

先确认变化是否只有行尾，不要直接执行`git reset --hard`或删除生成目录：

```powershell
git status --short
git diff --ignore-space-at-eol --exit-code
```

第二条命令退出码为`0`且没有输出，才表示当前未暂存变化只有行尾差异。对当前仓库保留LF检出策略，然后刷新索引：

```powershell
git config core.autocrlf input
git add -u
git diff --cached --exit-code
git status --short
```

`git add -u`会处理全部已跟踪文件，因此执行前必须先确认没有真实代码变化；刷新后`git diff --cached --exit-code`也必须为`0`。新文件在VS Code中建议使用`"files.eol": "\n"`。不要为了消除换行提示提交整仓CRLF/LF重写。

## Windows中文用户目录导致libmimalloc-sys或protoc构建失败

在中文名`%USERPROFILE%`下使用MSVC工具链时，部分第三方build script会把Cargo缓存或系统临时目录的绝对路径写入生成的C/C++源码或传给`protoc`。典型现象包括：

- `failed to run custom build command for libmimalloc-sys`；
- MSVC先报告`C4819`，随后`C1083`中的`%USERPROFILE%\.cargo`路径已经乱码；
- `DBProxy proto generation failed`，`prost-descriptor-set: No such file or directory`中的用户临时目录已经乱码。

这不是TiangZ源码缺失，也不是没有安装MSVC。保留现有账户时，在同一个PowerShell终端为C/C++编译器启用UTF-8，并把构建临时目录放到纯ASCII路径：

```powershell
$buildTemp = Join-Path $env:SystemDrive "TiangZBuildTemp"
New-Item -ItemType Directory -Force $buildTemp | Out-Null

$env:TEMP = $buildTemp
$env:TMP = $buildTemp
$env:CFLAGS = "/utf-8"
$env:CXXFLAGS = "/utf-8"

npm run starter:dev
```

环境变量必须在启动`npm`/`cargo`的同一终端设置，子进程会继承它们。需要长期使用时，可以把这四项写入用户环境变量，然后重新打开终端。`TEMP`和`TMP`指向的目录必须预先存在。

只修改Windows账户显示名称不会改变`%USERPROFILE%`的实际目录名。如需彻底改为英文配置目录，安全做法是新建英文名本地管理员账户、首次登录生成新的Profile，再迁移开发配置；不要直接重命名现有Profile目录或手工修改`ProfileImagePath`注册表项。

## Windows Release首次构建V8提示符号链接权限不足

Release首次编译`v8`时，如果看到`Failed to create symlink`和Windows错误`1314`（客户端没有所需的特权），说明当前账户不能创建目录符号链接。推荐在Windows“开发者设置”中开启开发者模式，重新打开终端后再构建；也可以从管理员终端执行构建。

无法开启开发者模式时，可以按错误日志中`Creating symlink <link> to <target>`显示的两个绝对路径，预先创建不要求符号链接权限的目录联接。例如当前Release缓存形状为：

```powershell
New-Item -ItemType Directory -Force target\release | Out-Null
New-Item -ItemType Junction `
  -Path target\release\gn_root `
  -Target (Join-Path $env:USERPROFILE ".cargo\registry\src\<registry>\v8-<version>")

npm run perf:rpc-baseline
```

`<registry>`和`<version>`必须使用本机错误日志中的实际目录，不能照抄示例占位符。这个联接只属于`target`构建缓存，执行清理命令删除`target`后需要重新创建；它不应提交到Git。长期使用Release构建时仍建议开启开发者模式。

## unknown scene type

确认class使用`@entryScene()`，文件位于`serverBundles.sceneSearchRoots`的`*/scenes/*.ts`范围，执行过`npm run codegen`，并检查`app/generated/bootstrap/scenes.ts`。

## Hotfix-only构建拒绝Model变化

`npm run build:hotfix`只适用于行为变化。字段、构造、继承、Core、协议锁或`.native`变化都会改变冻结指纹；应执行完整`npm run build`，部署配对的Model/Hotfix并重启Process。不要手工修改manifest绕过检查。

## scene not found / ambiguous scene

`knownScenes` 缺目标会 not found；`callOne` 对应多个同类型实例会 ambiguous。多实例先 `many()`，按业务规则选择具体 Scene。

## scene already exists

同一 ProcessHost 中动态 Scene ID 冲突。入口 Scene 应使用`SpawnChildScene(localId, ctor)`创建子Scene，让框架自动生成命名空间；不要绕过EntryScene直接操作ProcessHost。

## JS did not set a result

通常表示 Tick 返回的 Promise 未完成或被拒绝。重点检查 ordered Scene 之间是否形成 RPC 调用环。通知类反向链路应使用 `send`，不要用等待响应的 `call`。

## RPC timeout

依次检查 Scene 地址、进程是否监听、Inner Token、目标队列背压、Handler 耗时、Response msgcode 和 payload rpcId。

## 断点不命中

使用 `npm run build:debug`，确认 `debug` 位于 `process` 下，附加该 Process 的 Inspector 端口。生产 bundle 默认没有 sourcemap。

## cargo run 无法选择 binary

项目有多个二进制，使用：

```powershell
cargo run --bin TiangZ -- configs/local/all-in-one.json
```
