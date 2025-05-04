#[macro_export]
macro_rules! create_actorLocationRpcRequest {
    (
        $vis:vis struct $name:ident {
            $(
                $(#[$field_meta:meta])*
                $field_vis:vis $field:ident: $ty:tt
            ),* $(,)?
        }
    ) => {
        #[allow(non_camel_case_types)]
        #[derive(Debug, Serialize, Deserialize)]
        #[derive(IActorLocationRpcRequest)]
        $vis struct $name {
            pub _t: String,
            pub rpc_id: i32,
            $(
                $(#[$field_meta])*
                $field_vis $field: $ty,
            )*
        }
    };
}

#[macro_export]
macro_rules! create_actorLocationRpcResponse {
    (
        $vis:vis struct $name:ident {
            $(
                $(#[$field_meta:meta])*
                $field_vis:vis $field:ident: $ty:tt
            ),* $(,)?
        }
    ) => {
        #[allow(non_camel_case_types)]
        #[derive(Debug, Serialize, Deserialize)]
        #[derive(IActorLocationRpcResponse)]
        $vis struct $name {
            pub _t: String,
            pub rpc_id: i32,
            pub error: i32,
            pub message: String,
            $(
                $(#[$field_meta])*
                $field_vis $field: $ty,
            )*
        }
    };
}


#[macro_export]
macro_rules! create_actorLocationMessageRequest {
    (
        $vis:vis struct $name:ident {
            $(
                $(#[$field_meta:meta])*
                $field_vis:vis $field:ident: $ty:tt
            ),* $(,)?
        }
    ) => {
        #[allow(non_camel_case_types)]
        #[derive(Debug, Serialize, Deserialize)]
        #[derive(IActorLocationMessageRequest)]
        $vis struct $name {
            pub _t: String,
            $(
                $(#[$field_meta])*
                $field_vis $field: $ty,
            )*
        }
    };
}