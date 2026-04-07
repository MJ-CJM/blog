export interface FriendLink {
  name: string;
  url: string;
  avatar: string;
  description: string;
}

export const friendLinks: FriendLink[] = [
  {
    name: '旧博客',
    url: 'https://blog.mj-cjm.top',
    avatar: 'https://github.com/MJ-CJM.png',
    description: 'Hexo 博客，包含 Kubernetes 源码解析系列。',
  },
];
