import * as fsExtra from 'fs-extra';
import * as glob from 'glob';
import * as path from 'path';
import * as protobufjs from '@yunke/protobufjs';
import { Root } from '@yunke/protobufjs';
import { load, LoadRes as LoadResponse } from 'load-git'

export { loadFromJson, createPackageDefinition } from './loader';

const PROTO_CACHE = ".load-proto-cache";
const CACHE_DIR = `${process.cwd()}/${PROTO_CACHE}`;

interface IProtoDir {
  dir: string;
  rule: string;
}

async function pbjs(
  protoDirs: IProtoDir[],
  includeDir: string,
  resolvePath?: (origin: string, target: string, rootDir: string) => string | null | undefined | void,
): Promise<Root> {
  const protoFiles: string[] = [];
  await Promise.all(protoDirs.map((item) => {
    return new Promise((resolve, reject) => {
      glob(`${item.dir}${item.rule}`, (err, matches) => {
        if (err) {
          reject(err);
          return;
        }
        protoFiles.push(...matches);
        resolve(matches);
      });
    });
  }));

  const root = new protobufjs.Root();
  root.resolvePath = (origin, target) => {
    if (resolvePath) {
      const customerResolvePath = resolvePath(origin, target, includeDir);
      if (customerResolvePath) {
        return customerResolvePath;
      }
    }

    if (/^google\/(protobuf|api)/.test(target)) {
      return path.join(
        path.dirname(require.resolve('@yunke/protobufjs')),
        target,
      );
    } else if (origin) {
      return path.join(
        includeDir,
        target,
      );
    }
    return path.join(target);
  };

  return new Promise<any>((resolve, reject) => {
    root.load(
      protoFiles,
      {
        keepCase: true,
        alternateCommentMode: true,
      },
      (err, res) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(res);
      },
    );
  });
}

export interface IGitConfig {
  branch?: string;
  accessToken?: string;
  rule?: string;
}

export interface IGitConfigWithUrl extends IGitConfig {
  url: string;
  source?: string;
}

export interface ILoadResult {
  parentDir: string;
  path: string;
  rule?: string;
  clean?: boolean;
}


export interface IOption extends IGitConfig {
  gitUrls: Array<IGitConfigWithUrl | string>;
  resolvePath?: (origin: string, target: string, rootDir: string) =>
    string | null | undefined | void;
  loadProtoPlugin?: (option: IGitConfigWithUrl) => Promise<ILoadResult>
}

// 下载git proto仓库，生成grpc所需root
export async function loadProto(opt: IOption): Promise<Root> {
  const loadRes: ILoadResult[] = await loadResult(opt);
  const { root } = await genRoot(loadRes, opt.resolvePath);
  return root;
}

/**
 * 根据git url/branch/accessToken 下载proto文件，返回文件存放路径
 * @param opt 
 * @returns 
 */
export async function loadResult(opt: IOption): Promise<ILoadResult[]> {
  const {
    gitUrls,
    branch,
    accessToken,
    loadProtoPlugin
  } = opt;
  return await Promise.all(gitUrls.map(async (gitUrl) => {
    if (typeof gitUrl === 'string') {
      if (branch) {
        const options = { url: gitUrl, accessToken, branch }
        if (loadProtoPlugin) {
          const result: ILoadResult = await loadProtoPlugin(options)
          if (result) {
            return result
          }
        }
        return await load(options);
      }
      throw new Error(`git url ${gitUrl} must specified a branch`);
    }
    const url = gitUrl.url;
    let branch1 = gitUrl.branch;
    let accessToken1 = gitUrl.accessToken;
    if (typeof branch1 === 'undefined') {
      branch1 = branch;
    }
    if (typeof accessToken1 === 'undefined') {
      accessToken1 = accessToken;
    }
    if (branch1) {
      const options: IGitConfigWithUrl = {
        url: url,
        accessToken: accessToken1,
        branch: branch1,
        source: gitUrl.source,
      };

      if (loadProtoPlugin) {
        const result: ILoadResult = await loadProtoPlugin(options)
        if (result) {
          return {
            ...result,
            rule: gitUrl.rule,
          }
        }
      }
      const loadResponse: LoadResponse = await load(options);
      return {
        parentDir: loadResponse.parentDir,
        path: loadResponse.path,
        rule: gitUrl.rule,
      };
    }
    throw new Error(`git url ${url} must specified a branch: ${branch1}`);
  }));
}

/**
 * 根据proto文件存放记录生成grpc所需root,每次都会生成新的proto
 * @param loadRes 
 * @param resolvePath 
 * @returns 
 */
export async function genRoot(
  loadRes: ILoadResult[],
  resolvePath?: (origin: string, target: string, rootDir: string) =>
    string | null | undefined | void
): Promise<{ root: Root, protoDir: Array<{ dir: string, rule: string }> }> {
  const tempDir = `${CACHE_DIR}/${Math.random()}-${Date.now()}`;

  const deleteLoadGitCache = (cachedir: string[]) => {
    if (!cachedir || !cachedir.length) return
    cachedir.forEach(async (item: string) => await fsExtra.remove(item))
  }

  const pluginLoadGitCache: string[] = []

  try {
    await fsExtra.mkdirp(tempDir);

    const copyDirs = await Promise.all(loadRes.map(async (res) => {

      if (res.clean)
        pluginLoadGitCache.push(res.parentDir)

      const dest = `${tempDir}/${path.relative(res.parentDir, res.path)}`;

      await fsExtra.mkdirp(dest);

      await new Promise<void>((resolve, reject) => {
        fsExtra.copy(res.path, dest, (err: Error) => {
          if (err) {
            reject(err);
          }
          resolve();
        });
      });
      return {
        dir: dest,
        rule: res.rule || '/**/*.proto',
      };
    }));

    const root = await pbjs(copyDirs, tempDir, resolvePath);

    try {
      await fsExtra.remove(tempDir);
      deleteLoadGitCache(pluginLoadGitCache)
    } catch (e) {
      // nothing
    }

    return { root, protoDir: copyDirs };
  } catch (e) {
    await fsExtra.remove(tempDir);
    deleteLoadGitCache(pluginLoadGitCache)
    throw e;
  }
}

/**
 * 根据proto文件存放记录生成grpc所需root
 * @param loadRes
 * @param resolvePath
 * @returns
 */
export async function genRootByCache(
  protoDirs: Array<{ dir: string, rule: string }>,
  resolvePath?: (origin: string, target: string, rootDir: string) =>
    string | null | undefined | void,
): Promise<Root> {
  // 取出前面的路径
  const itemPath = protoDirs[0].dir;
  const items = itemPath.split(`${PROTO_CACHE}/`);
  const cwd = items[0];
  const randomStr = items[1].split("/")[0];
  const tempDir = cwd + PROTO_CACHE + "/" + randomStr;

  const root = await pbjs(protoDirs, tempDir, resolvePath);
  return root;
}
