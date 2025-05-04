///
/// MyError实现了：
/// 1：Debug        -> 用来支持显示
/// 2：Display      -> 用来支持显示
/// 3：std::error::Error -> 说明自己是个Error类型
///
///

///如果自定义一个MyTrait，然后想用系统的derive来自动对MyStruct实现MyTrait，那么就需要对MyTrait使用“派生宏”特性
/// 可以参考serde库的Serialize与Deserialize
use thiserror::Error;

#[allow(dead_code)]
pub type RetErr = std::boxed::Box<dyn std::error::Error + std::marker::Send + std::marker::Sync>;
#[allow(dead_code)]
pub type RetResult<T> = std::result::Result<T, RetErr>;

#[allow(dead_code)]
#[derive(Error, Debug)] //让编译器自动实现Debug的trait（相当于接口）
pub enum MyError {
    #[error("组件{0}已存在")]
    ComponentExist(&'static str),
    #[error("不是一段合法的rmp_serde,msgpack数据")]
    NotMessagePack(),
    #[error("消息缺少_t字段")]
    MessageNoTField(),
    #[error("找不到消息处理器: {0}")]
    MessageHandlerNotFound(String),
    #[error("消息对象转换失败")]
    MessageObjectConvertFailed(),
    #[error("发送请求失败")]
    SendRequestFailed(),
    // #[error("用户{0}已经存在")]
    // UserExist(String),
    // #[error("id can't conv to i64: {0}")]
    // DbIDErr(String),
    // #[error("账户名长度必须大于等于3: {0}")]
    // UserNameLen(String),
    // #[error("账户名不能包含空格: {0}")]
    // UserNameSpace(String),
    // #[error("密码长度必须大于等于3")]
    // PasswordLen,
    // #[error("bad http response: {0}")]
    // DBErr(String),
}

// impl std::fmt::Display for MyError {//手动实现Display这个trait，其中有一个必须实现的函数就是fmt
//     fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
//         match self {
//             _t::UserNotExist(account) => {
//                 write!(f, "用户{}不存在", account)
//             }
//             MyError::PasswordNot(password) => {
//                 write!(f, "密码不匹配: {}", password)
//             }
//             MyError::UserExist(account) => {
//                 write!(f, "用户{}已经存在", account)
//             }
//             MyError::DbIDErr(id) => {
//                 write!(f, "id can't conv to i64: {}", id)
//             }
//             MyError::UserNameLen(account) => {
//                 write!(f, "账户名长度必须大于等于3: {}", account)
//             }
//             MyError::UserNameSpace(account) => {
//                 write!(f, "账户名不能包含空格: {}", account)
//             }
//             MyError::PasswordLen => {
//                 write!(f, "密码长度必须大于等于3")
//             }
//             MyError::DBErr(message) => {
//                 write!(f, "数据库操作异常: {}",  message)
//             }
//         }
//     }
// }

//Error这个trait直接空就可以，没有需要实现的函数
// impl std::error::Error for MyError {
//
// }
