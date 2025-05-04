#![feature(prelude_import)]
#[prelude_import]
use std::prelude::rust_2024::*;
#[macro_use]
extern crate std;
use gen_macro::derive_entity;
use crate::entity::{Awake, Destroy};
mod errors {
    pub mod my_errors {
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
        pub type RetErr = std::boxed::Box<
            dyn std::error::Error + std::marker::Send + std::marker::Sync,
        >;
        pub type RetResult<T> = std::result::Result<T, RetErr>;
        pub enum MyError {
            #[error("组件{0}已存在")]
            ComponentExist(String),
        }
        #[allow(unused_qualifications)]
        #[automatically_derived]
        impl ::thiserror::__private::Error for MyError {}
        #[allow(unused_qualifications)]
        #[automatically_derived]
        impl ::core::fmt::Display for MyError {
            fn fmt(
                &self,
                __formatter: &mut ::core::fmt::Formatter,
            ) -> ::core::fmt::Result {
                use ::thiserror::__private::AsDisplay as _;
                #[allow(unused_variables, deprecated, clippy::used_underscore_binding)]
                match self {
                    MyError::ComponentExist(_0) => {
                        match (_0.as_display(),) {
                            (__display0,) => {
                                __formatter
                                    .write_fmt(format_args!("组件{0}已存在", __display0))
                            }
                        }
                    }
                }
            }
        }
        #[automatically_derived]
        impl ::core::fmt::Debug for MyError {
            #[inline]
            fn fmt(&self, f: &mut ::core::fmt::Formatter) -> ::core::fmt::Result {
                match self {
                    MyError::ComponentExist(__self_0) => {
                        ::core::fmt::Formatter::debug_tuple_field1_finish(
                            f,
                            "ComponentExist",
                            &__self_0,
                        )
                    }
                }
            }
        }
    }
}
use crate::errors::my_errors::{MyError, RetResult};
#[awake]
#[destroy]
pub struct Player {
    pub health: i32,
    pub level: u8,
    pub id: i64,
    pub children: std::cell::RefCell<
        std::collections::HashMap<i64, std::boxed::Box<dyn crate::entity::Entity>>,
    >,
    pub components: std::cell::RefCell<
        std::collections::HashMap<
            std::any::TypeId,
            std::boxed::Box<dyn crate::entity::Component>,
        >,
    >,
}
impl Player {
    pub fn new_origin_with_param(
        health: i32,
        level: u8,
        id: i64,
        children: std::cell::RefCell<
            std::collections::HashMap<i64, std::boxed::Box<dyn crate::entity::Entity>>,
        >,
        components: std::cell::RefCell<
            std::collections::HashMap<
                std::any::TypeId,
                std::boxed::Box<dyn crate::entity::Component>,
            >,
        >,
    ) -> Self {
        let mut ret = Self {
            health,
            level,
            id,
            children,
            components,
            id: utils::utils::generate_id(),
            children: std::cell::RefCell::new(std::collections::HashMap::new()),
            components: std::cell::RefCell::new(std::collections::HashMap::new()),
        };
        ret.awake();
        ret
    }
    pub fn new_origin() -> Self {
        let mut ret = Self {
            health: i32::default(),
            level: u8::default(),
            id: i64::default(),
            children: std::cell::RefCell::<
                std::collections::HashMap<
                    i64,
                    std::boxed::Box<dyn crate::entity::Entity>,
                >,
            >::default(),
            components: std::cell::RefCell::<
                std::collections::HashMap<
                    std::any::TypeId,
                    std::boxed::Box<dyn crate::entity::Component>,
                >,
            >::default(),
            id: utils::utils::generate_id(),
            children: std::cell::RefCell::new(std::collections::HashMap::new()),
            components: std::cell::RefCell::new(std::collections::HashMap::new()),
        };
        ret.awake();
        ret
    }
    pub fn get_child<T: crate::entity::Entity + 'static>(
        &self,
        key: &i64,
    ) -> std::option::Option<std::cell::Ref<T>> {
        let guard = self.children.borrow();
        std::cell::Ref::filter_map(
                guard,
                |map| {
                    map.get(key).and_then(|child| child.as_any().downcast_ref::<T>())
                },
            )
            .ok()
    }
    pub fn get_child_mut<T: crate::entity::Entity + 'static>(
        &self,
        key: &i64,
    ) -> std::option::Option<std::cell::RefMut<T>> {
        let guard = self.children.borrow_mut();
        std::cell::RefMut::filter_map(
                guard,
                |map| {
                    map.get_mut(key)
                        .and_then(|child| child.as_any_mut().downcast_mut::<T>())
                },
            )
            .ok()
    }
    pub fn get_component<T: crate::entity::Component + 'static>(
        &self,
    ) -> std::option::Option<std::cell::Ref<T>> {
        let guard = self.components.borrow();
        let key = std::any::TypeId::of::<T>();
        std::cell::Ref::filter_map(
                guard,
                |map| {
                    map.get(&key).and_then(|child| child.as_any().downcast_ref::<T>())
                },
            )
            .ok()
    }
    pub fn get_component_mut<T: crate::entity::Component + 'static>(
        &self,
    ) -> std::option::Option<std::cell::RefMut<T>> {
        let guard = self.components.borrow_mut();
        let key = std::any::TypeId::of::<T>();
        std::cell::RefMut::filter_map(
                guard,
                |map| {
                    map.get_mut(&key)
                        .and_then(|child| child.as_any_mut().downcast_mut::<T>())
                },
            )
            .ok()
    }
    pub fn insert_child_with_id(
        &self,
        key: i64,
        child: std::boxed::Box<dyn crate::entity::Entity>,
    ) -> std::option::Option<std::boxed::Box<dyn crate::entity::Entity>> {
        self.children.borrow_mut().insert(key, child)
    }
    pub fn insert_child(
        &self,
        child: std::boxed::Box<dyn crate::entity::Entity>,
    ) -> std::option::Option<std::boxed::Box<dyn crate::entity::Entity>> {
        self.children.borrow_mut().insert(child.get_id(), child)
    }
    pub fn add_child<T: crate::entity::Builder + crate::entity::Entity>(
        &self,
    ) -> std::cell::Ref<T> {
        let child_entity = T::new();
        let child_id = child_entity.get_id();
        self.children.borrow_mut().insert(child_id, Box::new(child_entity));
        std::cell::Ref::map(
            self.children.borrow(),
            |map| {
                map.get(&child_id)
                    .and_then(|e| e.as_any().downcast_ref::<T>())
                    .unwrap_or_else(|| {
                        ::core::panicking::panic_fmt(
                            format_args!("Child {0} not found after insertion", child_id),
                        );
                    })
            },
        )
    }
    pub fn add_child_mut<T: crate::entity::Builder + crate::entity::Entity>(
        &self,
    ) -> std::cell::RefMut<T> {
        let child_entity = T::new();
        let child_id = child_entity.get_id();
        self.children.borrow_mut().insert(child_id, Box::new(child_entity));
        std::cell::RefMut::map(
            self.children.borrow_mut(),
            |map| {
                map.get_mut(&child_id)
                    .and_then(|e| e.as_any_mut().downcast_mut::<T>())
                    .unwrap_or_else(|| {
                        ::core::panicking::panic_fmt(
                            format_args!(
                                "Child {0} not found after insertion",
                                child_id.to_string(),
                            ),
                        );
                    })
            },
        )
    }
    pub fn add_component<T: crate::entity::Builder + crate::entity::Component>(
        &self,
    ) -> RetResult<std::cell::Ref<T>> {
        let child_entity = T::new();
        let child_id = std::any::TypeId::of::<T>();
        if self.components.borrow().contains_key(&child_id) {
            return std::result::Result::Err(
                Box::new(MyError::ComponentExist(child_entity.to_type_string())),
            );
        }
        self.components.borrow_mut().insert(child_id, Box::new(child_entity));
        std::result::Result::Ok(
            std::cell::Ref::map(
                self.components.borrow(),
                |map| {
                    map.get(&child_id)
                        .and_then(|e| e.as_any().downcast_ref::<T>())
                        .unwrap_or_else(|| {
                            ::core::panicking::panic_fmt(
                                format_args!(
                                    "Component {0:?} not found after insertion",
                                    child_id,
                                ),
                            );
                        })
                },
            ),
        )
    }
    pub fn add_component_mut<T: crate::entity::Builder + crate::entity::Component>(
        &self,
    ) -> RetResult<std::cell::RefMut<T>> {
        let child_entity = T::new();
        let child_id = std::any::TypeId::of::<T>();
        if self.components.borrow().contains_key(&child_id) {
            return std::result::Result::Err(
                Box::new(MyError::ComponentExist(child_entity.to_type_string())),
            );
        }
        self.components.borrow_mut().insert(child_id, Box::new(child_entity));
        std::result::Result::Ok(
            std::cell::RefMut::map(
                self.components.borrow_mut(),
                |map| {
                    map.get_mut(&child_id)
                        .and_then(|e| e.as_any_mut().downcast_mut::<T>())
                        .unwrap_or_else(|| {
                            ::core::panicking::panic_fmt(
                                format_args!(
                                    "Component {0:?} not found after insertion",
                                    child_id,
                                ),
                            );
                        })
                },
            ),
        )
    }
    pub fn child_iter<T: Entity + 'static, F: FnMut(&T)>(&self, mut f: F)
    where
        F: FnMut(&T),
    {
        let children = self.children.borrow();
        for (k, v) in children.iter() {
            if let Some(vv) = v.as_any().downcast_ref::<T>() {
                f(vv);
            }
        }
    }
    pub fn child_iter_mut<T: Entity + 'static, F: FnMut(&mut T)>(&self, mut f: F) {
        let mut children = self.children.borrow_mut();
        for (_, child) in children.iter_mut() {
            if let Some(entity_ref) = child.as_any_mut().downcast_mut::<T>() {
                f(entity_ref);
            }
        }
    }
}
impl crate::entity::Entity for Player {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
    fn get_id(&self) -> i64 {
        self.id
    }
    fn to_type_string(&self) -> String {
        "Player".to_string()
    }
}
impl crate::entity::Builder for Player {
    fn new() -> Self {
        Player::new_origin()
    }
}
impl Drop for Player
where
    Self: crate::entity::Destroy,
{
    fn drop(&mut self) {
        self.destroy();
    }
}
trait PlayerAwake {
    fn player_awake(&mut self);
}
impl PlayerAwake for Player
where
    Self: crate::entity::Awake,
{
    fn player_awake(&mut self) {
        self.awake();
    }
}
impl ::core::fmt::Debug for Player {
    #[inline]
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Player")
            .field("health", &self.health)
            .field("level", &self.level)
            .field("id", &self.id)
            .field("children", &self.children)
            .field("components", &self.components)
            .finish()
    }
}
impl Awake for Player {
    fn awake(&mut self) {
        {
            ::std::io::_print(format_args!("Player awake called\n"));
        };
    }
}
impl Destroy for Player {
    fn destroy(&mut self) {
        {
            ::std::io::_print(format_args!("Player destroy called\n"));
        };
    }
}
fn main() {
    let mut player = Player::new_origin();
    player.awake();
    player.destroy();
}