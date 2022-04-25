#include <SKELETON.hpp>

SKELETON_::SKELETON_() 
{ 
    this->Type = "SKELETON";
}

SKELETON_::SKELETON_(nlohmann::json config)
{
    this->Type = "SKELETON";
}

nlohmann::json SKELETON_::Export()
{
    nlohmann::json config;
    return config;
}

extern "C"
{
    ecs::Component *create_component(void *p)
    {
        if(p == nullptr)
        {
            return new SKELETON_();
        }

        nlohmann::json *config = (nlohmann::json *)p;
        return new SKELETON_(*config);
    }
}
