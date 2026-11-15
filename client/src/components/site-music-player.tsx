import { useEffect } from 'react';

declare global {
    interface Window {
        APlayer: any;
        aplayerInstance: any;
    }
}

const PLAYLIST_ID = '18496000167'; // 歌单「博客音乐 歌神百晓」
const MUSIC_API_LIST = [
    `https://music.zhub.eu.cc/api?server=netease&type=playlist&id=${PLAYLIST_ID}`,
    `https://blogmusic.vercel.app/api?server=netease&type=playlist&id=${PLAYLIST_ID}`,
    `https://api.injahow.cn/meting/?server=netease&type=playlist&id=${PLAYLIST_ID}`,
];

const toHttps = (u?: string) => (u || '').replace(/^http:\/\//, 'https://');

/**
 * 背景音乐播放器：脚本与样式按需从 CDN 加载，歌单请求失败时静默跳过，
 * 不影响页面其它功能。
 */
export function useSiteMusicPlayer() {
    /** 初始化 APlayer 背景音乐（只会执行一次，重复挂载直接跳过） */
    useEffect(() => {
        if (!document.querySelector('meta[name="referrer"]')) {
            const meta = document.createElement('meta');
            meta.name = 'referrer';
            meta.content = 'no-referrer';
            document.head.appendChild(meta);
        }

        if (window.aplayerInstance || document.getElementById('aplayer-fixed-wrap')) return;

        if (!document.getElementById('aplayer-style-cdn')) {
            const link = document.createElement('link');
            link.id = 'aplayer-style-cdn';
            link.rel = 'stylesheet';
            link.href = 'https://cdnjs.cloudflare.com/ajax/libs/aplayer/1.10.1/APlayer.min.css';
            document.head.appendChild(link);
        }

        let cancelled = false;

        const fetchPlaylist = async (): Promise<any[]> => {
            for (const url of MUSIC_API_LIST) {
                try {
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), 15000);
                    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
                    clearTimeout(timer);
                    if (!res.ok) continue;

                    const data = await res.json();
                    if (Array.isArray(data) && data.length > 0) {
                        return data.map((item: any) => ({
                            name: item.name || item.title || '未知歌曲',
                            artist: item.artist || item.author || '未知歌手',
                            url: toHttps(item.url),
                            cover: toHttps(item.pic || item.cover),
                            lrc: toHttps(item.lrc),
                        }));
                    }
                } catch (e) {
                    console.warn('[music] API 请求失败:', url, e);
                }
            }
            return [];
        };

        const setupPlayer = (songs: any[]) => {
            document.querySelectorAll('.aplayer').forEach((el) => {
                if (el.parentElement?.id !== 'aplayer-fixed-wrap') el.remove();
            });

            let container = document.getElementById('aplayer-fixed-wrap');
            if (!container) {
                container = document.createElement('div');
                container.id = 'aplayer-fixed-wrap';
                document.body.appendChild(container);
            }

            const player = new window.APlayer({
                container,
                fixed: true,
                mini: false,
                autoplay: false,
                theme: '#10b981',
                loop: 'all',
                order: 'list',
                preload: 'metadata',
                volume: 0.7,
                listFolded: true,
                listMaxHeight: 280,
                lrcType: 3,
                audio: songs,
            });
            window.aplayerInstance = player;

            player.container?.classList.add('aplayer-narrow');

            let errorCount = 0;
            player.on('error', () => {
                errorCount += 1;
                if (errorCount <= 5) {
                    setTimeout(() => {
                        try { player.skipForward(); player.play(); } catch (e) {}
                    }, 800);
                }
            });
            player.on('playing', () => { errorCount = 0; });
        };

        const init = async () => {
            const songs = await fetchPlaylist();
            if (cancelled) return;
            if (songs.length === 0) return;
            setupPlayer(songs);
        };

        if (!window.APlayer) {
            let script = document.getElementById('aplayer-js') as HTMLScriptElement | null;
            if (!script) {
                script = document.createElement('script');
                script.id = 'aplayer-js';
                script.src = 'https://cdnjs.cloudflare.com/ajax/libs/aplayer/1.10.1/APlayer.min.js';
                document.head.appendChild(script);
            }
            script.addEventListener('load', init, { once: true });
        } else {
            init();
        }

        return () => {
            cancelled = true;
        };
    }, []);
}
