use proc_macro::TokenStream;
use quote::quote;
use syn::{parse_macro_input, DeriveInput, Ident, Attribute, punctuated::Punctuated, Token, Type, TypePath, ItemFn};

use syn::{FnArg,ReturnType};



type StructFields = syn::punctuated::Punctuated<syn::Field,syn::Token!(,)>;



fn get_fields_from_derive_input(d: &syn::DeriveInput) -> syn::Result<&StructFields> {
    if let syn::Data::Struct(syn::DataStruct {
        fields: syn::Fields::Named(syn::FieldsNamed { ref named, .. }),
        ..
    }) = d.data{
        return Ok(named)
    }
    Err(syn::Error::new_spanned(d, "Must define on a Struct, not Enum".to_string()))
}

fn contain_awake_attr(st: &syn::DeriveInput) -> bool {
    for attr in &st.attrs {
        if attr.path().is_ident("awake") {
            return true;
        }
    }
    false
}

fn contain_destroy_attr(st: &syn::DeriveInput) -> bool {
    for attr in &st.attrs {
        if attr.path().is_ident("destroy") {
            return true;
        }
    }
    false
}

fn do_expend(input: DeriveInput, tail_name: &str) -> TokenStream {
    let input_copy = input.clone();

    let struct_name = &input.ident;

    let entity_struct_name_string = format!("{}", struct_name);
    let entity_struct_name = Ident::new(&entity_struct_name_string, struct_name.span());

    let awake_struct_name_string = format!("{}Awake", entity_struct_name);
    let awake_struct_name = Ident::new(&awake_struct_name_string, struct_name.span());

    let awake_func_name_string = format!("{}_Awake", entity_struct_name);
    let awake_func_name = Ident::new(&awake_func_name_string.to_lowercase(), struct_name.span());

    // 解析原结构体字段
    let fields = get_fields_from_derive_input(&input).unwrap();

    let fields_data: Vec<_> = fields.iter()
    .filter(|f| {
        let ident_name = format!("{}", f.ident.as_ref().unwrap());
        ident_name != "id" && ident_name != "children" && ident_name != "components"
    })
    .map(|f| {
        let ident = &f.ident;
        let ty = &f.ty;
        quote! { #ident: #ty }
    })
    .collect();

    let fields_value: Vec<_> = fields.iter()
    .filter(|f| {
        let ident_name = format!("{}", f.ident.as_ref().unwrap());
        ident_name != "id" && ident_name != "children" && ident_name != "components"
    })
    .map(|f| {
        let ident = &f.ident;
        quote! { #ident }
    })
    .collect();

    let fields_value_default: Vec<_> = fields.iter()
    .filter(|f| {
        let ident_name = format!("{}", f.ident.as_ref().unwrap());
        ident_name != "id" && ident_name != "children" && ident_name != "components"
    })
    .map(|f| {
        let ident = &f.ident;
        let ty = &f.ty;
        quote! { #ident: #ty::default() }
    })
    .collect();

    let mut new_with_param = quote! {};

    if contain_awake_attr(&input_copy) {
        new_with_param.extend( quote! {
            pub fn new_origin_with_param( #(#fields_data),* ) -> std::sync::Arc<tokio::sync::Mutex<Self>> {
                let mut ret = Self {
                    #(#fields_value,)*
                    id: crate::utils::generate_id(),
                    children: dashmap::DashMap::new(),
                    components: dashmap::DashMap::new(),
                };

                let ret = std::sync::Arc::new(tokio::sync::Mutex::new(ret));
    
                ret.awake();
    
                ret
            }

            pub fn new_origin() -> std::sync::Arc<tokio::sync::Mutex<Self>> {
                let mut ret = Self {
                    #(#fields_value_default,)*
                    id: crate::utils::generate_id(),
                    children: dashmap::DashMap::new(),
                    components: dashmap::DashMap::new(),
                };

                let ret = std::sync::Arc::new(tokio::sync::Mutex::new(ret));

                ret.awake();

                ret
            }
        } );
    } else {
        new_with_param.extend( quote! {
            pub fn new_origin_with_param( #(#fields_data),* ) -> std::sync::Arc<tokio::sync::Mutex<Self>> {
                let ret = Self {
                    #(#fields_value,)*
                    id: crate::utils::generate_id(),
                    children: dashmap::DashMap::new(),
                    components: dashmap::DashMap::new(),
                };
                std::sync::Arc::new(tokio::sync::Mutex::new(ret))
            }

            pub fn new_origin() -> std::sync::Arc<tokio::sync::Mutex<Self>> {
                let ret = Self {
                    #(#fields_value_default,)*
                    id: crate::utils::generate_id(),
                    children: dashmap::DashMap::new(),
                    components: dashmap::DashMap::new(),
                };
                std::sync::Arc::new(tokio::sync::Mutex::new(ret))
            }
        } );
    }

    let builder_impl = quote! {
        impl crate::entity::Builder for #entity_struct_name {
            fn new() -> std::sync::Arc<tokio::sync::Mutex<Self>> {
                #entity_struct_name::new_origin()
            }
        }
    };

    let mut destroy_trait = quote!{};
    if contain_destroy_attr(&input_copy) {
        destroy_trait.extend(quote!{
            impl Drop for #entity_struct_name where Self: crate::entity::Destroy {
                fn drop(&mut self) {
                    self.destroy();
                }
            }
        });
    }

    let awake_trait = quote! {
        trait #awake_struct_name {
            fn #awake_func_name(&mut self);
        }
    };

    let mut awake_trait_impl = quote!{};
    if contain_awake_attr(&input_copy) {
        awake_trait_impl.extend(quote!{
            impl #awake_struct_name for std::sync::Arc<tokio::sync::Mutex<#entity_struct_name>> where Self: crate::entity::Awake {
                fn #awake_func_name(&mut self) {
                    self.awake();
                }
            }
        });
    }

    // 生成构造函数
    let new_method = quote! {
        impl #entity_struct_name {

            #new_with_param

            // pub fn get_child<T: crate::entity::EntityTrait + 'static>(&self, key: &i64) -> std::option::Option<std::cell::Ref<T>> {
            //     self.children.get(key).map(|child| child.as_any().downcast_ref::<T>()).ok()
            // }

            // pub fn get_child_mut<T: crate::entity::EntityTrait + 'static>(&self, key: &i64) -> std::option::Option<std::cell::RefMut<T>> {
            //     self.children.get_mut(key).map(|child| child.as_any_mut().downcast_mut::<T>()).ok()
            // }

            // pub fn get_child_orign(&self, key: &i64) ->  std::option::Option<std::cell::Ref<Box<dyn crate::entity::EntityTrait>>> {
                
            // }

            // pub fn get_child_origin_mut(&self, key: &i64) -> std::option::Option<std::cell::RefMut<Box<dyn crate::entity::EntityTrait>>> {
            //     let guard = self.children.borrow_mut();
            //     if guard.contains_key(key) {
            //         Some(std::cell::RefMut::map(guard, |map| {
            //             map.get_mut(key).unwrap()
            //         }))
            //     } else {
            //         None
            //     }
            // }

            // pub fn get_component<T: crate::entity::ComponentTrait + 'static>(&self) -> std::option::Option<std::cell::Ref<T>> {
            //     self.components.get(&std::any::TypeId::of::<T>()).map(|child| child.as_any().downcast_ref::<T>()).ok()
            // }

            // pub fn get_component_mut<T: crate::entity::ComponentTrait + 'static>(&self) -> std::option::Option<std::cell::RefMut<T>> {
            //     self.components.get_mut(&std::any::TypeId::of::<T>()).map(|child| child.as_any_mut().downcast_mut::<T>()).ok()
            // }


            // pub fn insert_child_with_id(&self, key: i64, child: std::boxed::Box<crate::entity::EntityType>) -> std::option::Option<std::boxed::Box<crate::entity::EntityType>> {
            //     //self.children.insert(key, child)
            //     self.children.borrow_mut().insert(key, child)
            // }

            // pub fn insert_child(&self, child: std::boxed::Box<crate::entity::EntityType>) -> std::option::Option<std::boxed::Box<crate::entity::EntityType>> {
            //     self.children.borrow_mut().insert(child.get_id(), child)
            // }

            // pub fn add_child<T: crate::entity::Builder + crate::entity::EntityTrait>(&self) -> std::cell::Ref<T> {
            //     let child_entity = T::new();
            //     let child_id = child_entity.get_id();
        
            //     self.children.borrow_mut().insert(child_id, Box::new(child_entity));
            
            //     std::cell::Ref::map(self.children.borrow(), |map| {
            //         map.get(&child_id)
            //             .and_then(|e| e.as_any().downcast_ref::<T>())
            //             .unwrap_or_else(|| panic!("Child {} not found after insertion", child_id.to_string()))
            //     })
            // }

            // pub fn add_child_mut<T: crate::entity::Builder + crate::entity::EntityTrait>(&self) -> std::cell::RefMut<T> {
            //     self.children.get_mut(&child_id)
            //         .and_then(|e| e.as_any_mut().downcast_mut::<T>())
            //         .unwrap_or_else(|| panic!("Child {} not found after insertion", child_id.to_string()))  
            // }

            // pub fn add_component<T>(&self) -> RetResult<std::cell::Ref<T>> 
            // where T: crate::entity::Builder + crate::entity::ComponentTrait + crate::entity::SelfNameTrait
            // {
            //     let child_id = std::any::TypeId::of::<T>();
            //     if self.components.borrow().contains_key(&child_id) {
            //         return std::result::Result::Err(Box::new(MyError::ComponentExist(T::to_type_string())));
            //     }
        
            //     self.components.borrow_mut().insert(child_id, Box::new(T::new()));
            
            //     // 获取不可变引用                
            //     std::result::Result::Ok(std::cell::Ref::map(self.components.borrow(), |map| {
            //         map.get(&child_id)
            //             .and_then(|e| e.as_any().downcast_ref::<T>())
            //             .unwrap_or_else(|| panic!("Component {:?} not found after insertion", child_id))
            //     }))
            // }

            // pub fn add_component_mut<T>(&self) -> RetResult<std::cell::RefMut<T>>
            // where T: crate::entity::Builder + crate::entity::ComponentTrait + crate::entity::SelfNameTrait
            // {
            //     let child_id = std::any::TypeId::of::<T>();
            //     if self.components.borrow().contains_key(&child_id) {
            //         return std::result::Result::Err(Box::new(MyError::ComponentExist(T::to_type_string())));
            //     }
                
            //     self.components.borrow_mut().insert(child_id, Box::new(T::new()));
        
            //     std::result::Result::Ok(std::cell::RefMut::map(self.components.borrow_mut(), |map| {
            //         map.get_mut(&child_id)
            //             .and_then(|e| e.as_any_mut().downcast_mut::<T>())
            //             .unwrap_or_else(|| panic!("Component {:?} not found after insertion", child_id))
            //     }))
            // }


            // pub fn child_iter<T: crate::entity::EntityTrait + 'static, F: FnMut(&T)>(&self, mut f: F)
            // where
            //     F: FnMut(&T),
            // {
            //     let children = self.children.borrow();
            //     for (k, v) in children.iter() {
            //         if let Some(vv) = v.as_any().downcast_ref::<T>(){
            //             f(vv);
            //         }
                    
            //     }
            // }

            // pub fn child_iter_mut<T: crate::entity::EntityTrait + 'static, F: FnMut(&mut T)>(&self, mut f: F) {
            //     let mut children = self.children.borrow_mut();
            //     for (_, child) in children.iter_mut() {
            //         if let Some(entity_ref) = child.as_any_mut().downcast_mut::<T>() {
            //             f(entity_ref);
            //         }
            //     }
            // }
        }
    };

    let mut orign_trait_impl = quote! {
        impl crate::entity::EntityTrait for #entity_struct_name {
            fn as_any(&self) -> &dyn std::any::Any { self }
            fn as_any_mut(&mut self) -> &mut dyn std::any::Any { self }
            fn get_id(&self) -> i64 { self.id }
        }

        impl crate::entity::SelfNameTrait for #struct_name {
            #[inline]
            fn to_type_string() -> &'static str {
                #entity_struct_name_string
            }
        }
    };

    if tail_name == "Component" {
        orign_trait_impl.extend( quote! {
            impl crate::entity::ComponentTrait for #entity_struct_name {
            }
        } );
    }
    
    let mut debug_field = quote! {
        f.debug_struct(#entity_struct_name_string)
    } ;

    for f in fields {
        let ident = &f.ident;
        let ident_name_string = ident.clone().unwrap().to_string();
        if ident_name_string != "id" && ident_name_string != "children" && ident_name_string != "components" {
            debug_field.extend(quote! { .field(#ident_name_string, &self.#ident) });
        }
    }

    debug_field.extend(quote! { .finish() });


    let debug_impl = quote! {
        impl ::core::fmt::Debug for #entity_struct_name {
            #[inline]
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                #debug_field
            }
        }
    };

    // 组合所有生成的代码
    let expanded = quote! {
        //#struct_def

        #new_method

        #orign_trait_impl

        #builder_impl

        #destroy_trait

        #awake_trait

        #awake_trait_impl
        
        #debug_impl
    };

    TokenStream::from(expanded)
}

fn do_expend_singleton(input: DeriveInput) -> TokenStream {
    let input_copy = input.clone();

    let struct_name = &input.ident;

    let entity_struct_name_string = format!("{}", struct_name);
    let entity_struct_name = Ident::new(&entity_struct_name_string, struct_name.span());

    let awake_struct_name_string = format!("{}Awake", entity_struct_name);
    let awake_struct_name = Ident::new(&awake_struct_name_string, struct_name.span());

    let awake_func_name_string = format!("{}_Awake", entity_struct_name);
    let awake_func_name = Ident::new(&awake_func_name_string.to_lowercase(), struct_name.span());

    // 解析原结构体字段
    let fields = get_fields_from_derive_input(&input).unwrap();

    let fields_data: Vec<_> = fields.iter()
    .filter(|f| {
        let ident_name = format!("{}", f.ident.as_ref().unwrap());
        ident_name != "id" && ident_name != "children" && ident_name != "components"
    })
    .map(|f| {
        let ident = &f.ident;
        let ty = &f.ty;
        quote! { #ident: #ty }
    })
    .collect();

    let fields_value: Vec<_> = fields.iter()
    .filter(|f| {
        let ident_name = format!("{}", f.ident.as_ref().unwrap());
        ident_name != "id" && ident_name != "children" && ident_name != "components"
    })
    .map(|f| {
        let ident = &f.ident;
        quote! { #ident }
    })
    .collect();

    let fields_value_default: Vec<_> = fields.iter()
    .filter(|f| {
        let ident_name = format!("{}", f.ident.as_ref().unwrap());
        ident_name != "id" && ident_name != "children" && ident_name != "components"
    })
    .map(|f| {
        let ident = &f.ident;
        let ty = &f.ty;
        quote! { #ident: #ty::default() }
    })
    .collect();

    let mut new_with_param = quote! {};

    if contain_awake_attr(&input_copy) {
        new_with_param.extend( quote! {
            pub fn new_origin_with_param( #(#fields_data),* ) -> &'static Self {
                static INSTANCE: std::sync::OnceLock<#struct_name> = std::sync::OnceLock::new();
                INSTANCE.get_or_init(|| {
                    let ret = Self {
                        #(#fields_value,)*
                        id: crate::utils::generate_id(),
                        children: dashmap::DashMap::new(),
                        components: dashmap::DashMap::new(),
                    };
                    ret.awake();
                    ret
                })
            }

            pub fn new_origin() -> &'static Self {
                static INSTANCE: std::sync::OnceLock<#struct_name> = std::sync::OnceLock::new();
                INSTANCE.get_or_init(|| {
                    let ret = Self {
                        #(#fields_value_default,)*
                        id: crate::utils::generate_id(),
                        children: dashmap::DashMap::new(),
                        components: dashmap::DashMap::new(),
                    };
                    ret.awake();
                    ret
                })
            }
        } );
    } else {
        new_with_param.extend( quote! {
            pub fn new_origin_with_param( #(#fields_data),* ) -> &'static Self {
                static INSTANCE: std::sync::OnceLock<#struct_name> = std::sync::OnceLock::new();
                INSTANCE.get_or_init(|| {
                    Self {
                        #(#fields_value,)*
                        id: crate::utils::generate_id(),
                        children: dashmap::DashMap::new(),
                        components: dashmap::DashMap::new(),
                    }
                })
            }

            pub fn new_origin() -> &'static Self {
                static INSTANCE: std::sync::OnceLock<#struct_name> = std::sync::OnceLock::new();
                INSTANCE.get_or_init(|| {
                    Self {
                        #(#fields_value_default,)*
                        id: crate::utils::generate_id(),
                        children: dashmap::DashMap::new(),
                        components: dashmap::DashMap::new(),
                    }
                })
            }
        } );
    }

    let builder_impl = quote! {
        impl crate::entity::StaticBuilder for #entity_struct_name {
            fn new() -> &'static Self {
                #entity_struct_name::new_origin()
            }
        }
    };

    let mut destroy_trait = quote!{};
    if contain_destroy_attr(&input_copy) {
        destroy_trait.extend(quote!{
            impl Drop for #entity_struct_name where Self: crate::entity::Destroy {
                fn drop(&mut self) {
                    self.destroy();
                }
            }
        });
    }

    let awake_trait = quote! {
        trait #awake_struct_name {
            fn #awake_func_name(&mut self);
        }
    };

    let mut awake_trait_impl = quote!{};
    if contain_awake_attr(&input_copy) {
        awake_trait_impl.extend(quote!{
            impl #awake_struct_name for #entity_struct_name where Self: crate::entity::Awake {
                fn #awake_func_name(&mut self) {
                    self.awake();
                }
            }
        });
    }

    // 生成构造函数
    let new_method = quote! {
        impl #entity_struct_name {

            #new_with_param

            // pub fn get_child<T: crate::entity::EntityTrait + 'static>(&self, key: &i64) -> std::option::Option<std::cell::Ref<T>> {
            //     self.children.get(key).map(|child| child.as_any().downcast_ref::<T>()).ok()
            // }

            // pub fn get_child_mut<T: crate::entity::EntityTrait + 'static>(&self, key: &i64) -> std::option::Option<std::cell::RefMut<T>> {
            //     self.children.get_mut(key).map(|child| child.as_any_mut().downcast_mut::<T>()).ok()
            // }

            // pub fn get_child_orign(&self, key: &i64) ->  std::option::Option<std::cell::Ref<Box<dyn crate::entity::EntityTrait>>> {
                
            // }

            // pub fn get_child_origin_mut(&self, key: &i64) -> std::option::Option<std::cell::RefMut<Box<dyn crate::entity::EntityTrait>>> {
            //     let guard = self.children.borrow_mut();
            //     if guard.contains_key(key) {
            //         Some(std::cell::RefMut::map(guard, |map| {
            //             map.get_mut(key).unwrap()
            //         }))
            //     } else {
            //         None
            //     }
            // }

            // pub fn get_component<T: crate::entity::ComponentTrait + 'static>(&self) -> std::option::Option<std::cell::Ref<T>> {
            //     self.components.get(&std::any::TypeId::of::<T>()).map(|child| child.as_any().downcast_ref::<T>()).ok()
            // }

            // pub fn get_component_mut<T: crate::entity::ComponentTrait + 'static>(&self) -> std::option::Option<std::cell::RefMut<T>> {
            //     self.components.get_mut(&std::any::TypeId::of::<T>()).map(|child| child.as_any_mut().downcast_mut::<T>()).ok()
            // }


            // pub fn insert_child_with_id(&self, key: i64, child: std::boxed::Box<crate::entity::EntityType>) -> std::option::Option<std::boxed::Box<crate::entity::EntityType>> {
            //     //self.children.insert(key, child)
            //     self.children.borrow_mut().insert(key, child)
            // }

            // pub fn insert_child(&self, child: std::boxed::Box<crate::entity::EntityType>) -> std::option::Option<std::boxed::Box<crate::entity::EntityType>> {
            //     self.children.borrow_mut().insert(child.get_id(), child)
            // }

            // pub fn add_child<T: crate::entity::Builder + crate::entity::EntityTrait>(&self) -> std::cell::Ref<T> {
            //     let child_entity = T::new();
            //     let child_id = child_entity.get_id();
        
            //     self.children.borrow_mut().insert(child_id, Box::new(child_entity));
            
            //     std::cell::Ref::map(self.children.borrow(), |map| {
            //         map.get(&child_id)
            //             .and_then(|e| e.as_any().downcast_ref::<T>())
            //             .unwrap_or_else(|| panic!("Child {} not found after insertion", child_id.to_string()))
            //     })
            // }

            // pub fn add_child_mut<T: crate::entity::Builder + crate::entity::EntityTrait>(&self) -> std::cell::RefMut<T> {
            //     self.children.get_mut(&child_id)
            //         .and_then(|e| e.as_any_mut().downcast_mut::<T>())
            //         .unwrap_or_else(|| panic!("Child {} not found after insertion", child_id.to_string()))  
            // }

            // pub fn add_component<T>(&self) -> RetResult<std::cell::Ref<T>> 
            // where T: crate::entity::Builder + crate::entity::ComponentTrait + crate::entity::SelfNameTrait
            // {
            //     let child_id = std::any::TypeId::of::<T>();
            //     if self.components.borrow().contains_key(&child_id) {
            //         return std::result::Result::Err(Box::new(MyError::ComponentExist(T::to_type_string())));
            //     }
        
            //     self.components.borrow_mut().insert(child_id, Box::new(T::new()));
            
            //     // 获取不可变引用                
            //     std::result::Result::Ok(std::cell::Ref::map(self.components.borrow(), |map| {
            //         map.get(&child_id)
            //             .and_then(|e| e.as_any().downcast_ref::<T>())
            //             .unwrap_or_else(|| panic!("Component {:?} not found after insertion", child_id))
            //     }))
            // }

            // pub fn add_component_mut<T>(&self) -> RetResult<std::cell::RefMut<T>>
            // where T: crate::entity::Builder + crate::entity::ComponentTrait + crate::entity::SelfNameTrait
            // {
            //     let child_id = std::any::TypeId::of::<T>();
            //     if self.components.borrow().contains_key(&child_id) {
            //         return std::result::Result::Err(Box::new(MyError::ComponentExist(T::to_type_string())));
            //     }
                
            //     self.components.borrow_mut().insert(child_id, Box::new(T::new()));
        
            //     std::result::Result::Ok(std::cell::RefMut::map(self.components.borrow_mut(), |map| {
            //         map.get_mut(&child_id)
            //             .and_then(|e| e.as_any_mut().downcast_mut::<T>())
            //             .unwrap_or_else(|| panic!("Component {:?} not found after insertion", child_id))
            //     }))
            // }


            // pub fn child_iter<T: crate::entity::EntityTrait + 'static, F: FnMut(&T)>(&self, mut f: F)
            // where
            //     F: FnMut(&T),
            // {
            //     let children = self.children.borrow();
            //     for (k, v) in children.iter() {
            //         if let Some(vv) = v.as_any().downcast_ref::<T>(){
            //             f(vv);
            //         }
                    
            //     }
            // }

            // pub fn child_iter_mut<T: crate::entity::EntityTrait + 'static, F: FnMut(&mut T)>(&self, mut f: F) {
            //     let mut children = self.children.borrow_mut();
            //     for (_, child) in children.iter_mut() {
            //         if let Some(entity_ref) = child.as_any_mut().downcast_mut::<T>() {
            //             f(entity_ref);
            //         }
            //     }
            // }
        }
    };

    let mut orign_trait_impl = quote! {
        impl crate::entity::EntityTrait for #entity_struct_name {
            fn as_any(&self) -> &dyn std::any::Any { self }
            fn as_any_mut(&mut self) -> &mut dyn std::any::Any { self }
            fn get_id(&self) -> i64 { self.id }
        }

        impl crate::entity::SelfNameTrait for #struct_name {
            #[inline]
            fn to_type_string() -> &'static str {
                #entity_struct_name_string
            }
        }
    };

    orign_trait_impl.extend( quote! {
        impl crate::entity::ComponentTrait for #entity_struct_name {
        }
    } );
    
    let mut debug_field = quote! {
        f.debug_struct(#entity_struct_name_string)
    } ;

    for f in fields {
        let ident = &f.ident;
        let ident_name_string = ident.clone().unwrap().to_string();
        if ident_name_string != "id" && ident_name_string != "children" && ident_name_string != "components" {
            debug_field.extend(quote! { .field(#ident_name_string, &self.#ident) });
        }
    }

    debug_field.extend(quote! { .finish() });


    let debug_impl = quote! {
        impl ::core::fmt::Debug for #entity_struct_name {
            #[inline]
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                #debug_field
            }
        }
    };

    // 组合所有生成的代码
    let expanded = quote! {
        //#struct_def

        #new_method

        #orign_trait_impl

        #builder_impl

        #destroy_trait

        #awake_trait

        #awake_trait_impl
        
        #debug_impl
    };

    TokenStream::from(expanded)
}

#[proc_macro_derive(Component, attributes(awake, destroy))]
pub fn component(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    do_expend(input, "Component")
}

#[proc_macro_derive(SingletonComponent, attributes(awake, destroy))]
pub fn singleton_component(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    do_expend_singleton(input)
}

#[proc_macro_derive(Entity, attributes(awake, destroy))]
pub fn entity(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    do_expend(input, "")
}

fn get_field_default(struct_name: String, fields: &StructFields) -> Vec<proc_macro2::TokenStream> {
    fields.iter()
    .filter(|f| {
        let ident_name = format!("{}", f.ident.as_ref().unwrap());
        ident_name != "id" && ident_name != "children" && ident_name != "components"
    })
    .map(|f| {
        let ident = &f.ident;
        let ty = &f.ty;

        let ident_name = format!("{}", f.ident.as_ref().unwrap());
        if ident_name == "_t" {
            quote! { #ident: String::from(#struct_name) }
        } else {
            quote! { #ident: #ty::default() }
        }
    })
    .collect()
}

fn parse_attributes(attrs: &[Attribute]) -> (syn::Type, syn::Type) {
    let mut request_type = None;
    let mut response_type = None;

    for attr in attrs {
        if attr.path().is_ident("RequestType") {
            request_type = Some(parse_type_from_attr(attr).unwrap());
        } else if attr.path().is_ident("ResponseType") {
            response_type = Some(parse_type_from_attr(attr).unwrap());
        }
    }

    (request_type.unwrap(), response_type.unwrap())
}

fn parse_message_attributes(attrs: &[Attribute]) -> syn::Type {
    let mut request_type = None;

    for attr in attrs {
        if attr.path().is_ident("RequestType") {
            request_type = Some(parse_type_from_attr(attr).unwrap());
        }
    }

    request_type.unwrap()
}

fn parse_type_from_attr(attr: &Attribute) -> Result<syn::Type, String> {
    let parser = Punctuated::<syn::Type, Token![,]>::parse_terminated;
    let types = attr.parse_args_with(parser).map_err(|e| e.to_string())?;
    
    if types.len() != 1 {
        return Err("Attribute must contain exactly one type".to_string());
    }
    Ok(types.first().unwrap().clone())
}

fn type_to_string(ty: &Type) -> String {
    match ty {
        // 处理普通路径类型（如 `C2M_PingRequest`）
        Type::Path(TypePath { path, .. }) => {
            path.segments
                .iter()
                .map(|seg| seg.ident.to_string())
                .collect::<Vec<_>>()
                .join("::")
        }
        // 其他类型情况的处理
        _ => panic!("Unsupported type: {:?}", ty),
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////

fn impl_imessage(input: &DeriveInput) -> proc_macro2::TokenStream {
    let struct_name = &input.ident;
    quote! {
        impl IMessage for #struct_name {
            fn with_serde_json_value(&self, message: serde_json::Value) 
            -> errors::my_errors::RetResult<Box<dyn IMessage>> {
                let v = serde_json::from_value::<#struct_name>(message)?;
                Ok(std::boxed::Box::new(v) as std::boxed::Box<dyn IMessage>)
            }
            fn as_any(&self) -> &dyn std::any::Any { self }
            fn get_type_name(&self) -> &str {
                self._t.as_str()
            }
            fn to_bytes(&self, buf: &mut bytes::BytesMut) {
                let mut writer = buf.writer();
                rmp_serde::encode::write_named(&mut writer, self).unwrap();
            }
            fn to_json_string(&self) -> String {
                serde_json::to_string(self).unwrap()
            }
        }
    }
}

fn impl_imessage_paraser(input: &DeriveInput) -> proc_macro2::TokenStream {
    let struct_name = &input.ident;
    let struct_name_string = struct_name.to_string();
    let paraser_type_string = format!("{}_paraser", struct_name);
    let paraser_type = Ident::new(&paraser_type_string, struct_name.span());

    quote! {
        #[allow(non_upper_case_globals)]
        static #paraser_type: LazyLock<std::boxed::Box<dyn IMessage>> = LazyLock::new(|| {
            std::boxed::Box::new(#struct_name::default()) as std::boxed::Box<dyn IMessage>
        });
        
        inventory::submit! {
            MessageParaser {
                key: #struct_name_string,
                paraser: &#paraser_type,
            }
        }
    }
}

fn impl_message_handler(input: &DeriveInput, request_type: &syn::Type) -> proc_macro2::TokenStream {
    let struct_name = &input.ident;
    let handler_type_string = format!("{}HANDLER_TYPE", struct_name);
    let handler_type = Ident::new(&handler_type_string, struct_name.span());
    let request_type_string = format!("{}", type_to_string(request_type));

    quote! {
        #[allow(non_upper_case_globals)]
        static #handler_type: LazyLock<Box<dyn IMActorHandler>> = LazyLock::new(|| {
            std::boxed::Box::new(#struct_name::default()) as std::boxed::Box<dyn IMActorHandler>
        });
        
        inventory::submit! {
            KeyedHandler {
                key: #request_type_string,
                handler: &#handler_type,
            }
        }
    }
}


#[allow(non_snake_case)]
#[proc_macro_derive(IActorLocationRpcRequest)]
pub fn IActorLocationRpcRequest(input: TokenStream) -> TokenStream {

    let input = parse_macro_input!(input as DeriveInput);
    let struct_name = &input.ident;

    // 解析原结构体字段
    let fields = get_fields_from_derive_input(&input).unwrap();

    //获取字段与默认值
    let struct_name_string = format!("{}", &input.ident);
    let fields_value_default= get_field_default(struct_name_string, &fields);
    
    let impl_imessage = impl_imessage(&input);

    let impl_imessage_paraser = impl_imessage_paraser(&input);
    
    let expanded = quote! {
        
        #impl_imessage
        
        impl IRequest for #struct_name {
            fn get_rpc_id(&self) -> i32 {
                self.rpc_id
            }
        }
        
        impl IActorRequest for #struct_name {
        }
        
        impl IActorLocationRequest for #struct_name {
        }

        impl GetLayer3Type for #struct_name {
            fn get_layer3_type() -> &'static Layer3Type {
                &Layer3Type::ActorLocationRequest
            }
        }

        impl Default for #struct_name {
            fn default() -> Self {
                Self {
                    #(#fields_value_default,)*
                }
            }
        }

        #impl_imessage_paraser
    };

    TokenStream::from(expanded)
}

#[allow(non_snake_case)]
#[proc_macro_derive(IActorLocationRpcResponse)]
pub fn IActorLocationRpcResponse(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    let struct_name = &input.ident;

    // 解析原结构体字段
    let fields = get_fields_from_derive_input(&input).unwrap();

    //获取字段与默认值
    let struct_name_string = format!("{}", &input.ident);
    let fields_value_default= get_field_default(struct_name_string, &fields);

    let impl_imessage = impl_imessage(&input);

    let impl_imessage_paraser = impl_imessage_paraser(&input);
    
    let expanded = quote! {

        #impl_imessage
        
        impl IResponse for #struct_name {
            fn get_rpc_id(&self) -> i32 {
                self.rpc_id
            }
            fn get_error(&self) -> i32 {
                self.error
            }
            fn get_message(&self) -> String {
                self.message.clone()
            }
        }
        
        impl IActorResponse for #struct_name {
        }
        
        impl IActorLocationResponse for #struct_name {
        }

        impl GetLayer3Type for #struct_name {
            fn get_layer3_type() -> &'static Layer3Type {
                &Layer3Type::ActorLocationResponse
            }
        }

        impl Default for #struct_name {
            fn default() -> Self {
                Self {
                    #(#fields_value_default,)*
                }
            }
        }

        #impl_imessage_paraser
    };

    TokenStream::from(expanded)
}

#[allow(non_snake_case)]
#[proc_macro_derive(IActorLocationRpcHandler, attributes(RequestType, ResponseType))]
pub fn IActorLocationRpcHandler(input: TokenStream) -> TokenStream {

    let input = parse_macro_input!(input as DeriveInput);
    let struct_name = &input.ident;

    let (request_type, response_type) = parse_attributes(&input.attrs);

    let impl_message_handler = impl_message_handler(&input, &request_type);

    let expanded = quote! {

        #[async_trait]
        impl IMActorHandler for #struct_name  {
            async fn handle_message(&self, message: Arc<Box<dyn IMessage>>, client_id: usize, 
                sender: std::option::Option<mpsc::Sender<NetworkMessage>>)  {
                let v = message.as_ref().as_any().downcast_ref::<#request_type>().unwrap();
                let mut response = #response_type::default();

                self.handler(v, &mut response).await;

                if let Some(sender) = sender {
                    let response_message = NetworkMessage::Response { 
                        client_id, data: std::sync::Arc::new(std::boxed::Box::new(response))};

                    match sender.try_send(response_message) {
                        Ok(()) => {},
                        Err(TrySendError::Full(response_message)) => {
                            trace!("通道已满，改用异步发送");
                            if let Err(e) = sender.send(response_message).await {
                                error!("IMActorHandler send handle_message 发送消息失败, 通道已关闭, {}", e);
                            }
                        }
                
                        Err(TrySendError::Closed(_)) => {
                            error!("IMActorHandler try_send handle_message 发送消息失败, 通道已关闭");
                        },
                    }
                }
            }
        }

        #[async_trait]
        impl AMActorLocationRpcHandler<#request_type, #response_type> for #struct_name  {
            async fn handler(&self, request: &#request_type, response: &mut #response_type)  {
                self.run(request, response).await;
                response.rpc_id = request.rpc_id;
            }
        }

        #impl_message_handler
    };

    TokenStream::from(expanded)
}



#[allow(non_snake_case)]
#[proc_macro_derive(IActorLocationMessageRequest)]
pub fn IActorLocationMessageRequest(input: TokenStream) -> TokenStream {

    let input = parse_macro_input!(input as DeriveInput);
    let struct_name = &input.ident;

    // 解析原结构体字段
    let fields = get_fields_from_derive_input(&input).unwrap();

    //获取字段与默认值
    let struct_name_string = format!("{}", &input.ident);
    let fields_value_default= get_field_default(struct_name_string, &fields);
    
    let impl_imessage = impl_imessage(&input);

    let impl_imessage_paraser = impl_imessage_paraser(&input);
    
    let expanded = quote! {
        
        #impl_imessage
        
        impl IActorMessage for #struct_name {
        }
        
        impl IActorLocationMessage for #struct_name {
        }

        impl GetLayer3Type for #struct_name {
            fn get_layer3_type() -> &'static Layer3Type {
                &Layer3Type::ActorLocationMessage
            }
        }

        impl Default for #struct_name {
            fn default() -> Self {
                Self {
                    #(#fields_value_default,)*
                }
            }
        }

        #impl_imessage_paraser
    };

    TokenStream::from(expanded)
}


#[allow(non_snake_case)]
#[proc_macro_derive(IActorLocationMessageHandler, attributes(RequestType))]
pub fn IActorLocationMessageHandler(input: TokenStream) -> TokenStream {

    let input = parse_macro_input!(input as DeriveInput);
    let struct_name = &input.ident;

    let request_type = parse_message_attributes(&input.attrs);

    let impl_message_handler = impl_message_handler(&input, &request_type);

    let expanded = quote! {

        #[async_trait]
        impl IMActorHandler for #struct_name  {
            async fn handle_message(&self, message: Arc<Box<dyn IMessage>>, client_id: usize, 
                sender: std::option::Option<mpsc::Sender<NetworkMessage>>)  {
                let v = message.as_ref().as_any().downcast_ref::<#request_type>().unwrap();
                self.handler(v).await;
            }
        }

        #[async_trait]
        impl AMActorLocationHandler<#request_type> for #struct_name  {
            async fn handler(&self, request: &#request_type)  {
                self.run(request).await;
            }
        }

        #impl_message_handler
    };

    TokenStream::from(expanded)
}

#[allow(non_snake_case)]
#[proc_macro_attribute]
pub fn ETTaskFunc(_attr: TokenStream, input: TokenStream) -> TokenStream {
    // 1. 解析输入函数
    let input_fn = parse_macro_input!(input as ItemFn);
    
    // 2. 提取函数各部分
    let attrs = &input_fn.attrs;      // 所有属性（如 #[doc], #[allow] 等）
    let vis = &input_fn.vis;          // 可见性（pub/pub(crate)等）
    let sig = &input_fn.sig;          // 函数签名
    let block = &input_fn.block;      // 函数体
    
    // 3. 处理函数签名
    let fn_name = &sig.ident;
    let fn_generics = &sig.generics;
    let fn_inputs = &sig.inputs;
    let fn_output = match &sig.output {
        ReturnType::Default => quote! { () },
        ReturnType::Type(_, ty) => quote! { #ty },
    };
    
    // 4. 转换输入参数（保持原有参数）
    let args = fn_inputs.iter().map(|arg| match arg {
        FnArg::Receiver(_) => quote! { self },  // 方法接收器（self）
        FnArg::Typed(pat_type) => {
            let pat = &pat_type.pat;
            let ty = &pat_type.ty;
            quote! { #pat: #ty }
        }
    });

    // 5. 生成转换后的函数
    let expanded = quote! {
        #(#attrs)*  // 保留原有属性
        #vis async fn #fn_name #fn_generics(#(#args),*) -> my_future::ETTask<#fn_output> {
            my_future::ETTask::new(async move #block)
        }
    };

    expanded.into()
}

// #[allow(non_snake_case)]
// #[proc_macro_attribute]
// pub fn event_handler(attr: TokenStream, item: TokenStream) -> TokenStream {
//     let event_type = parse_macro_input!(attr as Path);
//     let input_fn = parse_macro_input!(item as ItemFn);
//     let fn_name = &input_fn.sig.ident;
//     let fn_block = &input_fn.block;
    
//     // 生成结构体名称 (首字母大写)
//     let struct_name_string = format!("{}{}", &fn_name.to_string()[..1].to_uppercase(), &fn_name.to_string()[1..]);
//     // 生成结构体名称 (去掉首字母小写的函数名)
//     let struct_name = Ident::new(struct_name_string.as_str(), fn_name.span());
    
//     let expanded = quote! {
//         struct #struct_name;
        
//         #[::async_trait::async_trait]
//         impl crate::event::event_system::EventHandler for #struct_name {
//             type Event = #event_type;
            
//             async fn handle(&self, event: &Self::Event) {
//                 #fn_block
//             }
//         }
        
//         inventory::submit! {
//             crate::event::event_system::EventHandlerRecord {
//                 type_id: std::any::TypeId::of::<#event_type>(),
//                 handler: std::boxed::Box::new(#struct_name),
//             }
//         }
//     };
    
//     TokenStream::from(expanded)
// }

#[proc_macro_derive(Singleton)]
pub fn derive_singleton(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    let name = &input.ident;

    // 解析原结构体字段
    let fields = get_fields_from_derive_input(&input).unwrap();

    let fields_value_default: Vec<_> = fields.iter()
    .map(|f| {
        let ident = &f.ident;
        let ty = &f.ty;
        quote! { #ident: #ty::default() }
    })
    .collect();

    let expanded = quote! {
        impl #name {
            fn new() -> Self {
                #name { 
                    #(#fields_value_default,)*
                }
            }
        }

        impl Default for #name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl crate::Singleton for #name {
            fn instance() -> &'static Self {
                static INSTANCE: once_cell::sync::OnceCell<#name> = once_cell::sync::OnceCell::new();
                INSTANCE.get_or_init(#name::default)
            }
        }
    };

    TokenStream::from(expanded)
}

#[proc_macro_derive(EventHandler, attributes(EventType))]
pub fn derive_event_handler(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    let struct_name = &input.ident;

    let mut event_type = None;
    for attr in &input.attrs {
        if attr.path().is_ident("EventType") {
            event_type = Some(parse_type_from_attr(attr).unwrap());
            break;
        }
    }

    let event_type = event_type.expect("EventType attribute is required");

    let token_stream = quote! {
        impl #struct_name {
            fn register_handler(all_call_back: &crate::event::event_system::EventSystem) {
                all_call_back.register_call_back::<#event_type>(#struct_name);
            }
        }

        inventory::submit! {
            crate::event::event_system::CallBackHandlerFactory {
                register_fn: #struct_name::register_handler,
            }
        }
    };

    token_stream.into()
}

// #[proc_macro_derive(TimerEventHandler, attributes(EventType))]
// pub fn derive_timer_event_handler(input: TokenStream) -> TokenStream {
//     let input = parse_macro_input!(input as DeriveInput);
//     let struct_name = &input.ident;
//     //let struct_name_string = struct_name.to_string();

//     // 解析EventType属性以获取处理的事件类型
//     let mut event_type = None;
//     for attr in &input.attrs {
//         if attr.path().is_ident("EventType") {
//             event_type = Some(parse_type_from_attr(attr).unwrap());
//             break;
//         }
//     }

//     //let event_type = event_type.expect("EventHandler derive requires #[EventType(Type)] attribute");
//     //let event_type_string = type_to_string(&event_type);

//     // 生成处理器注册代码 - 使用运行时注册
//     let expanded = quote! {
//         // 实现Default特性，如果没有默认实现
//         impl Default for #struct_name {
//             fn default() -> Self {
//                 Self {}
//             }
//         }
        
//         // 定义初始化函数来注册事件处理器
//         impl #struct_name {
//             // 内部函数，在EventSystem初始化时会被调用
//             pub fn register_handler(system: &crate::event::event_system::EventSystem) {
//                 system.register::<#event_type>(#struct_name::default());
//             }
            
//             // 公共函数，可以在任何地方手动调用进行注册
//             pub fn register() {
//                 crate::event::event_system::EventSystem::instance()
//                     .register::<#event_type>(#struct_name::default());
//             }
//         }
        
//         // 在模块初始化时自动添加到注册列表
//         inventory::submit! {
//             crate::event::event_system::EventHandlerFactory {
//                 name: concat!(stringify!(#struct_name), "_factory"),
//                 register_fn: #struct_name::register_handler,
//             }
//         }
//     };

//     TokenStream::from(expanded)
// }



