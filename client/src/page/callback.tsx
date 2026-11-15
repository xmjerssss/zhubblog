import { useEffect } from "react";

export function CallbackPage() {
    useEffect(() => {
        // 登录态由服务端下发的 HttpOnly cookie 承载，不再从 URL 读取 token
        // （URL 上的 token 会进入浏览器历史、Referer 和统计脚本，且可被用于会话固定）。
        // 用整页跳转而不是前端路由：确保应用带着新 cookie 重新初始化用户状态，
        // 避免沿用登录前的空白 profile 而误判为"未登录"。
        window.location.replace("/");
    }, []);

    return (
        <>
            <div className="w-screen h-screen flex justify-center items-center">
                <div className="text-center text-black p-4 text-xl font-bold">
                    <p>Waiting...</p>
                </div>
            </div>
        </>
    );
}
