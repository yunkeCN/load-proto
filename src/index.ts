import * as fs from 'fs';
import * as glob from 'glob';
import * as mkdirp from 'mkdirp';
import * as path from 'path';
import * as protobufjs from 'protobufjs';
import { Root } from 'protobufjs';
import * as request from 'request';
import * as unzip from 'unzip';
import * as url from 'url';
import { getArchiveUrls, getBranchLastCommitId } from "./git";

const rmrf = require('rmrf');

const CACHE_DIR = `${process.cwd()}/load-proto-cache`;

interface IDownloadRes {
  path: string;
  dir: string;
  url: string;
}

async function downloadItem(
    urlStr: string,
    dir: string = `${CACHE_DIR}/${global.Date.now()}_${Math.random()}`,
    accessToken: string,
): Promise<IDownloadRes> {
  const urlObj = url.parse(urlStr, true);
  const zipName = urlStr
      .replace(/^https?:\/\//, '')
      .replace(/\/repository\/.+$/, '')
      .replace(/\//g, '_');
  const filePath = `${dir}/${zipName}.zip`;

  if (fs.existsSync(filePath)) {
    return { path: filePath, dir, url: urlStr };
  }

  await new Promise((resolve, reject) => {
    mkdirp(dir, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });

  return new Promise<any>((resolve, reject) => {
    request({
      url: urlStr + (!!urlObj.query.private_token ? '' : `?private_token=${accessToken}`),
      timeout: 30000,
    })
        .on('error', (err) => {
          rmrf(dir);
          reject(err);
        })
        .on('response', (res) => {
          if (res.statusCode === 404) {
            reject(new Error('系统错误，请联系管理员'));
          } else if (res.statusCode !== 200) {
            reject(new Error('服务器配置错误'));
          }
        })
        .pipe(fs.createWriteStream(filePath))
        .on('close', () => {
          resolve({ path: filePath, dir, url: urlStr });
        });
  });
}

async function download(
    urls: string[],
    accessToken: string,
    dir: string = `${CACHE_DIR}/${global.Date.now()}_${Math.random()}`,
): Promise<IDownloadRes[]> {
  return Promise.all(urls.map((item) => downloadItem(item, dir, accessToken)));
}

function unzipProcess(downloadResArr: IDownloadRes[]): Promise<string[]> {
  return Promise.all(downloadResArr.map((downloadRes) => {
    return new Promise<string>((resolve, reject) => {
      const targetDir = path.dirname(downloadRes.path) + '/' + downloadRes.url
          .replace(/^https?:\/\//, '')
          .replace(/\/repository\/.+$/, '');
      fs.createReadStream(downloadRes.path)
          .pipe(unzip.Parse())
          .on('entry', (entry) => {
            if (entry.type === 'File') {
              const filepath = `${targetDir}/${entry.path.split('/').slice(1).join('/')}`;
              const dir = path.dirname(filepath);
              mkdirp(dir, (err) => {
                if (err) {
                  reject(err);
                } else {
                  entry.pipe(fs.createWriteStream(filepath));
                }
              });
            }
          })
          .on('close', () => {
            resolve(targetDir);
          });
    });
  }));
}

async function pbjs(protoDirs: string[], includeDir: string): Promise<Root> {
  const protoFiles: string[] = [];
  await Promise.all(protoDirs.map((dir) => {
    return new Promise((resolve, reject) => {
      glob(`${dir}/**/*.proto`, (err, matches) => {
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
    if (target.indexOf('google/protobuf') === 0) {
      return `${path.dirname(require.resolve('protobufjs'))}/${target}`;
    } else if (target.indexOf('proto/') === 0) {
      // tslint:disable-next-line variable-name
      return target.replace(/^proto\/([^\/]+)(.+)/, (_target, $1, $2) => {
        return `${includeDir}/git.myscrm.cn/2c/${$1.replace(/_/g, '-')}${$2}`;
      });
    } else if (origin) {
      return `${includeDir}/${target}`;
    }
    return target;
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

const gitHttpReg = /https?:\/\/([^/]+)\/(.+)\.git/;
const gitSshReg = /git@([^:]+):(.+)\.git/;

function getUrlConfig(gitUrl: string): { host: string, repId: string } | null {
  let host = '';
  let repId = '';

  let exec = gitHttpReg.exec(gitUrl);
  if (exec) {
    host = exec[1];
    repId = exec[2];
  }

  if (!exec) {
    exec = gitSshReg.exec(gitUrl);

    if (exec) {
      host = exec[1];
      repId = exec[2];
    }
  }

  if (exec) {
    return { host, repId };
  }
  return null;
}

export async function loadProto(gitUrls: string[], branch: string, accessToken: string): Promise<Root> {
  const archiveUrls: string[] = gitUrls
      .map<string>((gitUrl) => {
        const archiveUrls = getArchiveUrls(gitUrl, [branch]);
        if (archiveUrls) {
          return archiveUrls[0];
        }
        return '';
      })
      .filter((item) => !!item);
  let tempDir;
  let root: Root;
  try {
    const branchLastCommitId = await getBranchLastCommitId(gitUrls[0], branch, accessToken);
    const downloadResArr = await download(
        [
          // 公共依赖仓库
          'https://git.myscrm.cn/golang/common/repository/master/archive.zip',
          ...archiveUrls,
        ],
        accessToken,
        (branchLastCommitId ? `${CACHE_DIR}/${branchLastCommitId}` : undefined),
    );
    tempDir = downloadResArr[0].dir;
    const protoDirs = await unzipProcess(downloadResArr);

    root = await pbjs(protoDirs.slice(1), tempDir);
  } catch (e) {
    if (tempDir) {
      rmrf(tempDir);
    }
    throw e;
  }

  return root;
}
