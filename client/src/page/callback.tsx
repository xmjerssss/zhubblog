import {useEffect} from "react";
import {useLocation} from "wouter";

export function CallbackPage() {
    const [, setLocation] = useLocation();
    useEffect(() => {
        // 登录态由服务端下发的 HttpOnly cookie 承载，不再从 URL 读取 token
        // （URL 上的 token 会进入浏览器历史、Referer 和统计脚本，且可被用于会话固定）。
        setLocation("/", { replace: true });
    }, [setLocation]);
    return (<>
        <div className="w-screen h-screen flex justify-center items-center">
            <div className="text-center text-black p-4 text-xl font-bold">
                <p>
                    Waiting...
                </p>
            </div>
        </div>
    </>)
}
