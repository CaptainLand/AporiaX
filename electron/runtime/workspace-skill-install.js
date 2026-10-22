import { inspectSkillDirectory, importUserSkill } from '../extension-library.js';
import { verifyExistingTarget, getVerifiedWorkspaceRoot } from './workspace-runtime.js';

export const INSTALL_WORKSPACE_SKILL = { type: 'function', function: {
  name: 'install_workspace_skill', description: 'Import a workspace Skill folder into personal Skills after explicit human confirmation. No scripts run. Existing installer validates, preserves update history and rejects conflicting names. Desktop main Agent only.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
} };

export function createWorkspaceSkillInstaller({ workspaceRoot, userDataDirectory, requestApproval, signal }) {
  return async input => {
    if (!input || typeof input.path !== 'string' || Object.keys(input).some(key => key !== 'path')) throw Error('请提供工作区内的 Skill 文件夹。');
    signal?.throwIfAborted();
    const root = await getVerifiedWorkspaceRoot(workspaceRoot);
    const sourceDirectory = await verifyExistingTarget(root, input.path);
    const before = await inspectSkillDirectory(sourceDirectory);
    if (!Object.hasOwn(before.hashes, 'SKILL.md')) throw Error('所选目录缺少 SKILL.md。');
    if (typeof requestApproval !== 'function') throw Error('安装 Skill 需要本次用户确认。');
    const approval = await requestApproval({ kind: 'skill-install', tool: 'install_workspace_skill', toolName: 'install_workspace_skill', canRememberForRun: false,
      title: '安装到个人技能库', command: input.path,
      description: `将此工作区 Skill 导入个人技能库，供后续任务复用。共 ${before.files} 个文件，${before.bytes} 字节。不会执行安装脚本；同来源更新会保留上一版本。`,
    });
    signal?.throwIfAborted();
    if (!approval?.approved || approval.automatic || approval.remembered) return { imported: false, status: 'rejected', message: '未安装。不要在没有新指示时重复请求。' };
    if (await verifyExistingTarget(root, input.path) !== sourceDirectory) throw Error('Skill 路径已变化，请重新确认。');
    return importUserSkill({ userDataDirectory, sourceDirectory, expectedHashes: before.hashes });
  };
}
