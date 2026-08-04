using System.IO;
using UnrealBuildTool;

public class TiangZClientSDK : ModuleRules
{
    public TiangZClientSDK(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        CppStandard = CppStandardVersion.Cpp20;

        PublicDependencyModuleNames.AddRange(new[] { "Core", "WebSockets" });
        PublicIncludePaths.Add(Path.Combine(ModuleDirectory, "..", "ThirdParty", "TiangZClientSDK", "include"));
    }
}
