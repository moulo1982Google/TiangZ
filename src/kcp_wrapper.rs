// #[cfg(test)]
// mod tests {
//     #![allow(unused_imports)]

//     use kcp_rust_native::*;


//     unsafe extern "C" fn udp_output (
//         buf: *const ::std::os::raw::c_char,
//         len: ::std::os::raw::c_int,
//         kcp: *mut IKCPCB,
//         _user: *mut ::std::os::raw::c_void,
//     ) -> ::std::os::raw::c_int {
//         ikcp_input(kcp, buf, len as i64);
//         return 0;
//     }

//     #[tokio::test]
//     async fn test_kcp_native() -> std::io::Result<()> {  

//         let kcp = unsafe { ikcp_create(0x11223344, std::ptr::null_mut()) }; 

//         unsafe { (*kcp).output = Some(udp_output) };
    
//         let mut buf : [u8 ; 20] = [0; 20];
//         let mut ori_data = String::from("hello world");
//         let mut tick : u32 = 0;
//         unsafe { 
//             loop {
//                 let data = ori_data.as_bytes_mut().as_mut_ptr();
//                 ikcp_update(kcp, tick);
//                 tick += 100;
    
//                 ikcp_send(kcp, data as *const i8 , 11);
//                 ikcp_update(kcp, tick);
    
//                 let received = ikcp_recv(kcp, buf.as_mut_ptr() as *mut i8, 20);
//                 if received != -1 {
//                     println!("{}" , String::from_utf8(buf[..{received as usize}].to_vec()).unwrap());
//                 }
//             }
//             ikcp_release(kcp);
//         };

//         Ok(())
//     }
// }
