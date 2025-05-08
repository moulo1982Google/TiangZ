#[macro_export]
macro_rules! create_entity {
    (
        $(#[$meta:meta])*
        $vis:vis struct $name:ident<$children_type:ty> {
            $(
                $(#[$field_meta:meta])*
                $field_vis:vis $field:ident: $ty:tt
            ),* $(,)?
        }
    ) => {
        $(#[$meta])*
        $vis struct $name {
            $(
                $(#[$field_meta])*
                $field_vis $field: $ty,
            )*
            pub id: i64,
            pub children:
                dashmap::DashMap::<
                    i64, 
                    std::borrow::Cow<'static, $children_type>
                >,
            pub components: 
                dashmap::DashMap::<
                    std::any::TypeId, 
                    std::sync::Arc<tokio::sync::Mutex<crate::entity::ComponentType>>
                >,
        }
    };

    (
        $(#[$meta:meta])*
        $vis:vis struct $name:ident {
            $(
                $(#[$field_meta:meta])*
                $field_vis:vis $field:ident: $ty:tt
            ),* $(,)?
        }
    ) => {
        $(#[$meta])*
        $vis struct $name {
            $(
                $(#[$field_meta])*
                $field_vis $field: $ty,
            )*
            pub id: i64,
            pub children:
                dashmap::DashMap::<
                    i64, 
                    std::borrow::Cow<'static, crate::entity::ChildType>
                >,
            pub components: 
                dashmap::DashMap::<
                    std::any::TypeId, 
                    std::sync::Arc<tokio::sync::Mutex<crate::entity::ComponentType>>
                >,
        }
    };
}