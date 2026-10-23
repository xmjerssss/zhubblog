import { useContext, useEffect, useRef, useState } from 'react';
import Popup from 'reactjs-popup';
import { useLocation } from 'wouter';
import { ClientConfigContext } from '../state/config';
import { Helmet } from "react-helmet";
import { siteName } from '../utils/constants';
import { useTranslation } from "react-i18next";
import { buildLoginPath, HIDDEN_LOGIN_REDIRECT } from "../utils/auth-redirect";

type ThemeMode = 'light' | 'dark' | 'system';

declare global {
    interface Window {
        APlayer: any;
        aplayerInstance: any;
    }
}

// ===== 音乐配置 =====
const PLAYLIST_ID = '18496000167'; // 歌单「博客音乐 歌神百晓」
const MUSIC_API_LIST = [
    `https://music.zhub.eu.cc/api?server=netease&type=playlist&id=${PLAYLIST_ID}`,
    `https://blogmusic.vercel.app/api?server=netease&type=playlist&id=${PLAYLIST_ID}`,
    `https://api.injahow.cn/meting/?server=netease&type=playlist&id=${PLAYLIST_ID}`,
];

const toHttps = (u?: string) => (u || '').replace(/^http:\/\//, 'https://');

function Footer() {
    const { t } = useTranslation();
    const [location, setLocation] = useLocation();
    const [modeState, setModeState] = useState<ThemeMode>('system');
    const config = useContext(ClientConfigContext);
    const footerHtml = config.get<string>('footer');
    const footerHtmlRef = useRef<HTMLDivElement | null>(null);
    const mountedScriptNodesRef = useRef<HTMLScriptElement[]>([]);
    const loginEnabled = config.getBoolean('login.enabled');
    const [doubleClickTimes, setDoubleClickTimes] = useState(0);

    const [runningTime, setRunningTime] = useState<string>('');
    const [hitokotoText, setHitokotoText] = useState<string>('');

    // ★ 智能单页与评论拦截器（已彻底修复：使用 removeProperty 确保普通文章评论必定恢复显示）
    useEffect(() => {
        const handlePageExtras = () => {
            const currentPath = window.location.pathname;

            // 1. 公告（/notice）与关于（/about）页面判断（严格精确路径匹配）
            const isFullCleanPage = 
                currentPath === '/notice' || 
                currentPath.startsWith('/notice/') ||
                currentPath === '/about' ||
                currentPath.startsWith('/about/') ||
                document.getElementById('page-clean-mode') !== null ||
                document.querySelector('article a[href*="page-clean-mode"]') !== null;

            // 2. 普通文章自定义仅关评论暗号（严格只在当前文章正文内检测，绝不误伤）
            const isHideCommentOnly = 
                document.getElementById('hide-comment') !== null ||
                document.querySelector('article a[href*="hide-comment"], .markdown a[href*="hide-comment"]') !== null;

            // 获取底部的评论卡片
            const commentInputs = Array.from(document.querySelectorAll('textarea, button'));
            const submitBtn = commentInputs.find(el => 
                el.textContent?.trim().includes('发表评论') || 
                el.textContent?.trim().includes('Comment')
            );
            const commentTextarea = document.querySelector('textarea');
            const targetNode = submitBtn || commentTextarea;

            let commentCard: HTMLElement | null = null;
            if (targetNode) {
                let p: HTMLElement | null = targetNode.parentElement;
                while (p && p !== document.body) {
                    if (
                        p.classList.contains('border-card') || 
                        p.classList.contains('bg-w') ||
                        p.classList.contains('rounded-2xl') ||
                        p.classList.contains('rounded-xl') ||
                        (p.parentElement && p.parentElement.tagName === 'MAIN')
                    ) {
                        commentCard = p;
                        break;
                    }
                    p = p.parentElement;
                }
            }

            // 获取上一篇/下一篇（Previous / Next）推荐卡片
            const allLinks = Array.from(document.querySelectorAll('a, span, p'));
            const prevNextElement = allLinks.find(el => 
                el.textContent?.trim().includes('Previous') || 
                el.textContent?.trim().includes('Next')
            );
            const adjacentCard = prevNextElement ? (prevNextElement.closest('.border-card, .bg-w, div[class*="rounded"]') as HTMLElement | null) : null;

            // ====== 核心修复：必须使用 removeProperty('display') 彻底清除 !important ======
            if (isFullCleanPage) {
                // 公告与关于：评论和 Next 按钮全部隐藏
                if (commentCard) commentCard.style.setProperty('display', 'none', 'important');
                if (adjacentCard) adjacentCard.style.setProperty('display', 'none', 'important');
            } else if (isHideCommentOnly) {
                // 普通文章加了暗号：隐藏评论，但【彻底恢复】Next 按钮
                if (commentCard) commentCard.style.setProperty('display', 'none', 'important');
                if (adjacentCard) adjacentCard.style.removeProperty('display');
            } else {
                // ★ 没有任何暗号的普通文章：全部【彻底恢复显示】！
                if (commentCard) commentCard.style.removeProperty('display');
                if (adjacentCard) adjacentCard.style.removeProperty('display');
            }
        };

        handlePageExtras();
        const timer = setInterval(handlePageExtras, 200);
        return () => clearInterval(timer);
    }, [location]);

    // 1. 每日一言打字机动效
    useEffect(() => {
        const quotes = [
            "不要因为结束而哭泣，微笑吧",
            "山水一程，三生有幸",
            "纵使疾风起，人生不言弃",
            "给时光以生命，给岁月以文明",
            "追风赶月莫停留，平平仄仄人间游",
            "星光不问赶路人，时光不负有心人",
            "心之所向，素履以往"
        ];

        let quoteIndex = 0;
        let charIndex = 0;
        let isDeleting = false;
        let currentQuote = quotes[0];
        let timer: any = null;

        const typeSpeed = 120;
        const deleteSpeed = 60;
        const pauseTime = 3200;

        const tick = () => {
            if (!isDeleting) {
                setHitokotoText(currentQuote.slice(0, charIndex + 1));
                charIndex++;
                if (charIndex === currentQuote.length) {
                    isDeleting = true;
                    timer = setTimeout(tick, pauseTime);
                    return;
                }
                timer = setTimeout(tick, typeSpeed);
            } else {
                setHitokotoText(currentQuote.slice(0, charIndex - 1));
                charIndex--;
                if (charIndex === 0) {
                    isDeleting = false;
                    quoteIndex = (quoteIndex + 1) % quotes.length;
                    currentQuote = quotes[quoteIndex];
                    timer = setTimeout(tick, 500);
                    return;
                }
                timer = setTimeout(tick, deleteSpeed);
            }
        };

        timer = setTimeout(tick, 1000);

        fetch('https://v1.hitokoto.cn/?encode=json')
            .then(res => res.json())
            .then(data => {
                if (data && data.hitokoto) {
                    quotes.splice(1, 0, data.hitokoto);
                }
            })
            .catch(() => {});

        return () => clearTimeout(timer);
    }, []);

    // 2. 运行时间统计
    useEffect(() => {
        const startDate = new Date(2024, 0, 1, 0, 0, 0);
        const calculateTime = () => {
            const diff = Date.now() - startDate.getTime();
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((diff % (1000 * 60)) / 1000);

            const years = Math.floor(days / 365);
            const remainingDays = days % 365;

            if (years > 0) {
                setRunningTime(`本站已勉强支撑 ${years} 年 ${remainingDays} 天 ${hours} 小时 ${minutes} 分 ${seconds} 秒`);
            } else {
                setRunningTime(`本站已勉强支撑 ${days} 天 ${hours} 小时 ${minutes} 分 ${seconds} 秒`);
            }
        };

        calculateTime();
        const timer = setInterval(calculateTime, 1000);
        return () => clearInterval(timer);
    }, []);

    // 3. 初始化播放器并加载歌单
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

    // 4. 主题初始化
    useEffect(() => {
        const mode = (localStorage.getItem('theme') as ThemeMode) || 'system';
        setModeState(mode);
        setMode(mode);
    }, []);

    // 5. 注入自定义 Footer HTML
    useEffect(() => {
        const container = footerHtmlRef.current;
        if (!container) return;

        mountedScriptNodesRef.current.forEach((script) => script.remove());
        mountedScriptNodesRef.current = [];
        container.replaceChildren();

        if (!footerHtml) return;

        const template = document.createElement('template');
        template.innerHTML = footerHtml;

        const scripts = Array.from(template.content.querySelectorAll('script'));
        scripts.forEach((script) => script.remove());

        container.appendChild(template.content.cloneNode(true));

        scripts.forEach((script) => {
            const nextScript = document.createElement('script');
            Array.from(script.attributes).forEach((attribute) => {
                nextScript.setAttribute(attribute.name, attribute.value);
            });
            nextScript.textContent = script.textContent;
            container.appendChild(nextScript);
            mountedScriptNodesRef.current.push(nextScript);
        });

        return () => {
            mountedScriptNodesRef.current.forEach((script) => script.remove());
            mountedScriptNodesRef.current = [];
        };
    }, [footerHtml]);

    const setMode = (mode: ThemeMode) => {
        setModeState(mode);
        localStorage.setItem('theme', mode);

        if (mode !== 'system') {
            document.documentElement.setAttribute('data-color-mode', mode);
        } else {
            const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
            document.documentElement.setAttribute('data-color-mode', mediaQuery.matches ? 'dark' : 'light');
        }
        window.dispatchEvent(new Event("colorSchemeChange"));
    };

    return (
        <footer>
            <Helmet>
                <link rel="alternate" type="application/rss+xml" title={siteName} href="/rss.xml" />
                <link rel="alternate" type="application/atom+xml" title={siteName} href="/atom.xml" />
                <link rel="alternate" type="application/json" title={siteName} href="/rss.json" />
                <meta name="referrer" content="no-referrer" />

                <style>{`
                    a[href*="hide-comment"],
                    a[href*="page-clean-mode"] {
                        display: none !important;
                    }

                    header button,
                    nav button,
                    .header button {
                        position: relative !important;
                        z-index: 50 !important;
                        flex-shrink: 0 !important;
                    }

                    header .flex-1,
                    header > div,
                    nav > div {
                        min-width: 0 !important;
                    }

                    header p,
                    nav p,
                    .header p {
                        overflow: hidden !important;
                        text-overflow: ellipsis !important;
                        white-space: nowrap !important;
                        max-width: calc(100vw - 160px) !important;
                        display: block !important;
                    }

                    footer {
                        margin-top: auto !important;
                        padding-bottom: 115px !important;
                    }

                    .aplayer.aplayer-fixed {
                        z-index: 999999 !important;
                        bottom: 10px !important;
                        left: 8px !important;
                    }
                    .aplayer.aplayer-fixed:not(.aplayer-narrow) {
                        width: 380px !important;
                        max-width: calc(100vw - 16px) !important;
                    }
                    .aplayer.aplayer-fixed:not(.aplayer-narrow) .aplayer-body {
                        width: 100% !important;
                        height: 66px !important;
                        background: #1f2937 !important;
                        border-bottom-left-radius: 8px !important;
                        border-bottom-right-radius: 8px !important;
                        overflow: visible !important;
                    }

                    .aplayer.aplayer-fixed.aplayer-narrow .aplayer-body {
                        width: 66px !important;
                        height: 66px !important;
                        border-radius: 8px !important;
                    }

                    .aplayer.aplayer-fixed .aplayer-pic {
                        width: 66px !important;
                        height: 66px !important;
                        background-size: cover !important;
                        background-position: center !important;
                        background-repeat: no-repeat !important;
                        display: block !important;
                        float: left !important;
                        background-color: #374151 !important;
                        border-bottom-left-radius: 8px !important;
                        position: relative !important;
                        overflow: hidden !important;
                    }

                    .aplayer.aplayer-fixed .aplayer-info {
                        height: 66px !important;
                        margin-left: 66px !important;
                        margin-right: 34px !important;
                        padding: 10px 4px 0 8px !important;
                        box-sizing: border-box !important;
                        display: block !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-info .aplayer-music {
                        display: block !important;
                        height: 20px !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-info .aplayer-music .aplayer-title {
                        color: #ffffff !important;
                        font-size: 14px !important;
                        font-weight: bold !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-info .aplayer-music .aplayer-author {
                        color: #9ca3af !important;
                        font-size: 12px !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-info .aplayer-controller {
                        display: block !important;
                        position: relative !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-info .aplayer-controller .aplayer-time {
                        display: block !important;
                        color: #9ca3af !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-icon {
                        width: 18px !important;
                        height: 18px !important;
                        display: inline-block !important;
                        opacity: 0.85 !important;
                        cursor: pointer !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-icon svg {
                        width: 100% !important;
                        height: 100% !important;
                        display: block !important;
                        fill: #d1d5db !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-icon:hover svg {
                        fill: #10b981 !important;
                    }

                    .aplayer.aplayer-fixed .aplayer-miniswitcher {
                        display: flex !important;
                        align-items: center !important;
                        justify-content: center !important;
                        position: absolute !important;
                        right: 0 !important;
                        top: 0 !important;
                        bottom: 0 !important;
                        width: 32px !important;
                        background: #374151 !important;
                        border-left: 1px solid #4b5563 !important;
                        border-top-right-radius: 8px !important;
                        border-bottom-right-radius: 8px !important;
                        cursor: pointer !important;
                        z-index: 99999 !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-miniswitcher .aplayer-icon {
                        display: none !important;
                    }
                    .aplayer.aplayer-fixed:not(.aplayer-narrow) .aplayer-miniswitcher::after {
                        content: '◀' !important;
                        font-size: 14px !important;
                        color: #ffffff !important;
                        font-weight: bold !important;
                    }
                    .aplayer.aplayer-fixed.aplayer-narrow .aplayer-miniswitcher::after {
                        content: '▶' !important;
                        font-size: 14px !important;
                        color: #ffffff !important;
                        font-weight: bold !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-miniswitcher:hover {
                        background: #4b5563 !important;
                    }

                    .aplayer.aplayer-fixed .aplayer-lrc {
                        position: absolute !important;
                        bottom: 66px !important;
                        left: 0 !important;
                        right: 0 !important;
                        width: 100% !important;
                        height: 28px !important;
                        text-align: center !important;
                        pointer-events: none !important;
                        z-index: 999999 !important;
                        background: rgba(17, 24, 39, 0.92) !important;
                        backdrop-filter: blur(4px) !important;
                        border-top-left-radius: 8px !important;
                        border-top-right-radius: 8px !important;
                        border: 1px solid rgba(55, 65, 81, 0.6) !important;
                        border-bottom: none !important;
                        box-sizing: border-box !important;
                        overflow: hidden !important;
                        margin: 0 !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-lrc:before,
                    .aplayer.aplayer-fixed .aplayer-lrc:after {
                        display: none !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-lrc p {
                        font-size: 13px !important;
                        color: #9ca3af !important;
                        margin: 0 !important;
                        padding: 0 8px !important;
                        white-space: nowrap !important;
                        overflow: hidden !important;
                        text-overflow: ellipsis !important;
                        opacity: 0.2 !important;
                        transition: all 0.3s ease !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-lrc p.aplayer-lrc-current {
                        opacity: 1 !important;
                        color: #10b981 !important;
                        font-weight: bold !important;
                    }

                    .aplayer.aplayer-fixed.aplayer-narrow .aplayer-lrc {
                        display: none !important;
                    }

                    /* 列表抽屉样式 */
                    .aplayer.aplayer-fixed .aplayer-list {
                        background: #111827 !important;
                        border-top: 1px solid #374151 !important;
                        position: relative !important;
                        z-index: 1000 !important;
                        max-height: 280px !important;
                        overflow-y: auto !important;
                        overscroll-behavior: contain !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-list ol {
                        max-height: none !important;
                        overflow: visible !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-list::-webkit-scrollbar {
                        width: 6px !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-list::-webkit-scrollbar-thumb {
                        background: #4b5563 !important;
                        border-radius: 3px !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-list ol li {
                        border-top: 1px solid #1f2937 !important;
                        color: #d1d5db !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-list ol li:hover {
                        background: #1f2937 !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-list ol li.aplayer-list-light {
                        background: #374151 !important;
                    }
                    .aplayer.aplayer-fixed .aplayer-list ol li.aplayer-list-light .aplayer-list-title,
                    .aplayer.aplayer-fixed .aplayer-list ol li.aplayer-list-light .aplayer-list-author {
                        color: #10b981 !important;
                    }
                `}</style>
            </Helmet>

            <div className="flex flex-col mb-4 space-y-2 justify-center items-center t-primary ani-show">
                <p className="text-xs text-neutral-400 select-none">已经到底了哦~~~~</p>

                <div className="flex gap-2 text-xs">
                    <a href="https://youtube.com" target="_blank" rel="noopener noreferrer" className="inline-flex rounded overflow-hidden">
                        <span className="bg-neutral-800 text-white px-1.5 py-0.5">YouTube</span>
                        <span className="bg-red-600 text-white px-1.5 py-0.5 font-bold">油管</span>
                    </a>
                    <a href="https://afdian.com" target="_blank" rel="noopener noreferrer" className="inline-flex rounded overflow-hidden">
                        <span className="bg-neutral-800 text-white px-1.5 py-0.5">$$$</span>
                        <span className="bg-emerald-500 text-white px-1.5 py-0.5 font-bold">资助</span>
                    </a>
                </div>

                <div className="flex items-center gap-3 text-lg text-neutral-500 my-1">
                    <a href="https://github.com/xmjerssss" target="_blank" rel="noopener noreferrer" className="hover:text-neutral-800 dark:hover:text-neutral-200 transition-colors" title="GitHub">
                        <i className="ri-github-line" />
                    </a>
                    <span className="text-xs text-neutral-400">|</span>
                    <a href="https://space.bilibili.com" target="_blank" rel="noopener noreferrer" className="hover:text-neutral-800 dark:hover:text-neutral-200 transition-colors" title="Bilibili">
                        <i className="ri-bilibili-line" />
                    </a>
                    <span className="text-xs text-neutral-400">|</span>
                    <a href="mailto:admin@776789.xyz" className="hover:text-neutral-800 dark:hover:text-neutral-200 transition-colors" title="Email">
                        <i className="ri-mail-line" />
                    </a>
                </div>

                <div>
                    <a href="https://icp.gov.moe/?keyword=20262789" target="_blank" rel="noopener noreferrer" className="text-xs text-neutral-500 underline hover:text-neutral-700 dark:hover:text-neutral-300">
                        萌ICP备20262789号
                    </a>
                </div>

                {runningTime && (
                    <div className="text-xs text-neutral-500">
                        {runningTime}
                    </div>
                )}

                <div className="text-xs text-neutral-500 flex items-center gap-1.5 flex-wrap justify-center">
                    <span className="inline-flex items-center gap-1">
                        Protected by
                        <a
                            href="https://www.cloudflare.com"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center text-[#F38020] hover:opacity-80 transition-opacity"
                            title="Protected by Cloudflare"
                        >
                            <svg role="img" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5 inline-block">
                                <path d="M19.785 14.733c.15-.52.09-.98-.16-1.32-.23-.32-.61-.5-1.07-.53l-8.77-.11c-.08 0-.15-.05-.17-.12-.03-.07-.02-.15.03-.2.05-.06.12-.09.2-.09l8.85-.11c1.05-.05 2.19-.89 2.62-1.93.44-1.07.2-2.31-.59-3.11-.79-.81-1.95-1.12-3.03-.83-.34-1.63-1.66-2.92-3.34-3.23-1.68-.31-3.34.42-4.18 1.83-.56-.37-1.25-.56-1.95-.53-1.16.05-2.2.68-2.77 1.69-.58 1.01-.58 2.25-.01 3.26-.85.34-1.48 1.07-1.67 1.97-.2 1 .15 2 .91 2.68.76.67 1.8.94 2.78.72l12.44.02c.07 0 .15-.03.2-.08.06-.06.09-.14.07-.22z"/>
                            </svg>
                        </a>
                    </span>

                    <span>|</span>

                    <span className="inline-flex items-center gap-1">
                        Storage by
                        <a
                            href="https://secure.backblaze.com/b2_reports.htm#detail"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center text-[#E21E29] hover:opacity-80 transition-opacity"
                            title="Storage by Backblaze B2"
                        >
                            <svg role="img" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5 inline-block">
                                <path d="M12 12.9a2.9 2.9 0 0 1-2.9-2.9c0-.4.08-.78.23-1.13C8.42 10.15 7.8 11.97 7.8 14a6.2 6.2 0 1 0 12.4 0c0-1.68-.66-3.22-1.74-4.38-.07.41-.21.8-.41 1.16A4.3 4.3 0 0 1 12 12.9zm1.74-10.82c-.22-.38-.72-.49-1.07-.23-.29.21-.43.58-.35.93.38 1.66-.02 3.42-1.08 4.71-.56.68-1.29 1.2-2.12 1.52-.39.15-.62.56-.55.97.07.41.43.72.85.72.06 0 .12 0 .18-.02 1.21-.29 2.27-.97 3.03-1.94.85-1.09 1.29-2.45 1.24-3.83.67 1.05.97 2.3.83 3.56-.05.42.23.8.65.86.42.06.8-.23.86-.65.25-1.92-.3-3.83-1.47-5.26-.37-.45-.71-.89-.99-1.33z"/>
                            </svg>
                        </a>
                    </span>

                    <span>|</span>

                    <span className="inline-flex items-center gap-1">
                        Analytics by
                        <a
                            href="https://cloud.umami.is"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center hover:text-neutral-800 dark:hover:text-neutral-200 transition-colors"
                            title="Umami Analytics"
                        >
                            <svg role="img" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5 inline-block">
                                <path d="M2.203 8.611H.857a.845.845 0 0 0-.841.841v.858a13.31 13.31 0 0 0-.016.6c0 6.627 5.373 12 12 12 6.527 0 11.837-5.212 11.996-11.701 0-.025.004-.05.004-.075V9.452a.845.845 0 0 0-.841-.841h-1.346c-1.159-4.329-5.112-7.521-9.805-7.521-4.692 0-8.645 3.192-9.805 7.521Zm18.444 0H3.37c1.127-3.702 4.57-6.399 8.638-6.399 4.069 0 7.512 2.697 8.639 6.399Z"/>
                            </svg>
                        </a>
                    </span>
                </div>

                {/* 每日一言打字机滚动语录 */}
                <div className="text-xs text-neutral-500 dark:text-neutral-400 text-center max-w-[92vw] px-4 py-1 tracking-wide leading-relaxed break-words whitespace-normal select-none transition-all">
                    <span>{hitokotoText}</span>
                    <span className="inline-block font-mono text-emerald-500 dark:text-emerald-400 animate-pulse ml-0.5 font-bold">|</span>
                </div>

                <div ref={footerHtmlRef} />

                <p className='text-sm text-neutral-500 font-normal link-line'>
                    <span onDoubleClick={() => {
                        if (doubleClickTimes >= 2) {
                            setDoubleClickTimes(0);
                            if (!loginEnabled) {
                                setLocation(buildLoginPath(HIDDEN_LOGIN_REDIRECT));
                            }
                        } else {
                            setDoubleClickTimes(doubleClickTimes + 1);
                        }
                    }}>
                        © {new Date().getFullYear()} Powered by <a className='hover:underline' href="https://github.com/openRin/Rin" target="_blank" rel="noopener noreferrer">Rin</a>
                    </span>
                    {config.getBoolean('rss') && <>
                        <Spliter />
                        <Popup
                            trigger={<button className="hover:underline" type="button">RSS</button>}
                            position="top center"
                            arrow={false}
                            closeOnDocumentClick>
                            <div className="border-card">
                                <p className="font-bold t-primary">{t('subscription') || 'RSS'}</p>
                                <p>
                                    <a href="/rss.xml" target="_blank" rel="noopener noreferrer">RSS</a>
                                    <Spliter />
                                    <a href="/atom.xml" target="_blank" rel="noopener noreferrer">Atom</a>
                                    <Spliter />
                                    <a href="/rss.json" target="_blank" rel="noopener noreferrer">JSON</a>
                                </p>
                            </div>
                        </Popup>
                    </>}
                </p>

                <div className="w-fit t-primary bg-secondary bg-button rounded-full flex flex-row items-center justify-between space-x-4 p-2 mt-2">
                    <ThemeButton mode="light" current={modeState} label="Toggle light mode" icon="ri-sun-line" onClick={setMode} />
                    <ThemeButton mode="system" current={modeState} label="Toggle system mode" icon="ri-computer-line" onClick={setMode} />
                    <ThemeButton mode="dark" current={modeState} label="Toggle dark mode" icon="ri-moon-line" onClick={setMode} />
                </div>
            </div>
        </footer>
    );
}

function Spliter() {
    return (<span className='mx-2'>|</span>);
}

function ThemeButton({ current, mode, label, icon, onClick }: {
    current: ThemeMode;
    label: string;
    icon: string;
    mode: ThemeMode;
    onClick: (mode: ThemeMode) => void;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            className={`rounded-full w-8 h-8 flex items-center justify-center transition-colors ${current === mode ? 'bg-w t-primary' : ''}`}
            onClick={() => onClick(mode)}
        >
            <i className={icon} />
        </button>
    );
}

export default Footer;
