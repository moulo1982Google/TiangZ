# BlueChibi角色源文件

`BlueChibi.blend`是Cocos 3D Demo蓝发玩家角色的可编辑源文件，运行时只使用：

```text
assets/resources/Demo/Characters/Player/blue_chibi/BlueChibi.glb
```

模型采用1.8米脚底原点、低面数材质、基础人形骨骼和原地动画。`Idle`与`Walk`不包含Root Motion，玩家坐标仍由TiangZ权威移动与客户端预测控制。

安装Blender 5.2 LTS后可以重新生成：

```powershell
npm run asset:cocos3d:blue-chibi
```

生成入口是`tools/assets/generate_blue_chibi.mjs`，建模脚本是`tools/assets/generate_blue_chibi.py`。禁止只在`.blend`中修改后手工导出而不更新生成脚本，否则下次生成会覆盖修改。
