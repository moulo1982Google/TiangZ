#![allow(unused_imports)]

use TiangZ::create_entity;
use gen_macro::Entity;
use crate::entity::Builder;
//use crate::errors::my_errors::{MyError, RetResult};
use tracing::trace;
use tracing::info;
use crate::entity::scene::Scene;
use crate::entity::server_scene_manager::ServerSceneManagerComponent;

use super::scene::SceneFactory;

//use crate::entity::ComponentType;


pub struct Root {
    scene: Scene,

    components: dashmap::DashMap::<
        std::any::TypeId, 
        std::sync::Arc<std::sync::RwLock<crate::entity::ComponentType>>
    >,
}

impl Root {

    pub fn instance() -> &'static Self {
        static INSTANCE: std::sync::OnceLock<Root> = std::sync::OnceLock::new();
        INSTANCE.get_or_init(|| {
            Root::new()
        })
    }


    fn add_component<T: crate::entity::ComponentTrait + crate::entity::Builder + 'static  + Send + Sync>(&self) {
        self.components.insert(std::any::TypeId::of::<T>(), 
        std::sync::Arc::new(std::sync::RwLock::new(T::new())));
    }

    fn get_component<T: crate::entity::ComponentTrait + crate::entity::Builder + 'static  + Send + Sync>(&self) -> Option<std::sync::Arc<std::sync::RwLock<T>>> {
        let type_id = std::any::TypeId::of::<T>();
        self.components.get(&type_id).and_then(|value_ref| {
            let arc = value_ref.clone();
            
            // 首先检查类型是否匹配
            let is_match = {
                let borrowed = arc.read().unwrap();
                borrowed.as_any().downcast_ref::<T>().is_some()
            };
            
            if is_match {
                // 使用类型转换处理
                unsafe {
                    let raw_ptr = std::sync::Arc::into_raw(arc);
                    let typed_ptr = raw_ptr as *const std::sync::RwLock<T>;
                    Some(std::sync::Arc::from_raw(typed_ptr))
                }
            } else {
                None
            }
        })
    }

    pub fn new() -> Self {
        let ins = Self {
            scene: SceneFactory::create_scene(super::scene::SceneType::Process, None),
            components: dashmap::DashMap::new(),
        };

        ins.add_component::<ServerSceneManagerComponent>();



        ins
    }

    pub async fn run(&self) {
        info!("Root run");
    }
}

#[cfg(test)]
mod tests {
    #![allow(unused_variables)]
    use super::*;
    use std::borrow::Cow;
    use std::cell::RefCell;
    use std::any::TypeId;
    use std::sync::{Arc, RwLock};

    trait MyTrait: Clone + 'static {
        fn as_any(&self) -> &dyn std::any::Any;
        fn as_any_mut(&mut self) -> &mut dyn std::any::Any; 
    }

    #[derive(Clone)]
    struct MyStruct {
        id: i64,
    }

    impl MyTrait for MyStruct {
        fn as_any(&self) -> &dyn std::any::Any { self }
        fn as_any_mut(&mut self) -> &mut dyn std::any::Any { self }
    }


    // 定义一个通用trait，所有组件都需要实现
    trait Component: 'static {
        fn new() -> Self where Self: Sized;
    }

    // 让MyStruct实现Component
    impl Component for MyStruct {
        fn new() -> Self {
            MyStruct {id: 0}
        }
    }

    // 为String实现Component，用于测试
    impl Component for String {
        fn new() -> Self {
            String::new()
        }
    }

    // 为u32实现Component，用于测试
    impl Component for u32 {
        fn new() -> Self {
            0
        }
    }

    // Store actual instances directly
    struct Test {
        // 修改为直接使用 Cow<MyStruct>
        pub childrens: dashmap::DashMap<i64, Cow<'static, MyStruct>>,
        // 修改为使用TypeId作为键
        pub components: dashmap::DashMap<TypeId, Arc<std::sync::RwLock<dyn std::any::Any + 'static>>>,
    }

    impl Test {
        
        fn add_child(&self) {
            let obj: Cow<'static, MyStruct> = Cow::Owned(MyStruct::new());
            self.childrens.insert(obj.as_ref().id, obj);
        }

        fn add_child_with_id(&self, key: i64) {
            let mut obj: Cow<'static, MyStruct> = Cow::Owned(MyStruct::new());
            obj.to_mut().id = key;
            self.childrens.insert(obj.as_ref().id, obj);
        }

        // 统一的get_child函数，返回Cow
        fn get_child(&self, key: i64) -> Option<Cow<'static, MyStruct>> {
            self.childrens.get(&key).map(|child| child.clone())
        }

        // 修改insert为使用TypeId作为键
        fn add_component<T: Component + 'static>(&self) -> TypeId {
            let type_id = TypeId::of::<T>();
            // 使用T::new()创建组件
            self.components.insert(type_id, Arc::new(RwLock::new(T::new())));
            type_id
        }

        // 修改为使用TypeId获取组件
        fn get_component<T: 'static + Clone>(&self) -> Option<Arc<RefCell<T>>> {
            let type_id = TypeId::of::<T>();
            self.components.get(&type_id).and_then(|value_ref| {
                let arc = value_ref.clone();
                
                // 首先检查类型是否匹配
                let is_match = {
                    let borrowed = arc.read().unwrap();
                    borrowed.downcast_ref::<T>().is_some()
                };
                
                if is_match {
                    // 使用类型转换处理
                    unsafe {
                        let raw_ptr = Arc::into_raw(arc);
                        let typed_ptr = raw_ptr as *const RefCell<T>;
                        Some(Arc::from_raw(typed_ptr))
                    }
                } else {
                    None
                }
            })
        }
    }

    #[tokio::test]
    async fn test_get_child() {
        let test = Test {
            components: dashmap::DashMap::new(),
            childrens: dashmap::DashMap::new(),
        };

        // 创建并存储MyStruct
        test.add_child_with_id(1);
        let id = 128;
        test.add_child_with_id(id);


        // 在components中存储默认类型，不再需要传递键
        test.add_component::<String>();
        
        // 获取MyStruct实例
        let retrieved = test.get_child(1);
        assert!(retrieved.is_some(), "Should retrieve MyStruct");
        
        // 获取String组件，并演示修改
        let string_component = test.get_component::<String>();
        assert!(string_component.is_some(), "Should retrieve String");
        
        // 修改组件
        if let Some(string_ref) = test.get_component::<String>() {
            let mut string = string_ref.borrow_mut();
            string.push_str(" modified");
        }

        // 测试不存在的键
        let not_found = test.get_child(3);
        assert!(not_found.is_none(), "Should not find anything for key 3");
        
        // 测试类型不匹配的情况 - 首先插入String类型，然后尝试获取u32类型
        test.add_component::<u32>();
        let wrong_type = test.get_component::<bool>();  // 尝试获取未注册的类型
        assert!(wrong_type.is_none(), "Should not be able to retrieve unregistered type");
        
        // 演示Cow的读写功能
        if let Some(cow) = test.get_child(1) {
            // 读取 - 不会克隆
            let child_ref = cow.as_ref();
            // ... 进行只读操作
            
            // 修改 - 会在必要时克隆
            // let mut child_mut = cow.to_mut();
            // ... 进行修改操作
        }
    }
}

